#!/usr/bin/env bash
# INTENTIUS/choudoufu#2246 (H3): the three-cloud demo's change set, with the
# Azure site planned by choudoufu. The bundled example is copied out, its
# emulators booted under scratch names, and `scripts/front-door.ts plan`
# composes one change set over the four members: `chant lifecycle plan` for
# dns, aws and gcp, and chant's choudoufuPlanSet (`choudoufu live-plan-set`)
# for the azure estate. Asserted from the document the step writes, never its
# exit code:
#
#   1. four members under one document digest: azure's part has planner
#      choudoufu, beside dns, aws and gcp with planner chant, all planned;
#   2. azure's part carries choudoufu's root digest as nativeDigest, and its
#      entries are the estate's own (the container app is a create on a
#      fresh floci-az);
#   3. the document's digest verifies (verifyChangeSetDigest), so one gate
#      over it binds every part.
#
# Nothing is applied. Scratch discipline (src/scratch.ts): the containers
# are behold-three-cloud-floci, -floci-az and -floci-gcp on their own ports,
# refused if one already exists, removed on exit by those names and no
# other. Skips, exit 0, with the reason, when Docker or choudoufu is absent:
# CI has neither. On macOS, floci-az's TLS certificate is choudoufu's
# scripts/floci-az-mac-cert.sh one, trusted in the keychain
# (example-three-cloud/scripts/emulators-up.sh says why).
set -euo pipefail
cd "$(dirname "$0")/.."
WORK="${BEHOLD_E2E_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/behold-three-cloud-e2e.XXXXXX")}"
TARGET="$WORK/three-cloud"

CHOUDOUFU="${CHOUDOUFU_BIN:-choudoufu}"
if ! docker info >/dev/null 2>&1; then echo "skip: Docker is not running"; exit 0; fi
if ! command -v "$CHOUDOUFU" >/dev/null 2>&1; then echo "skip: ${CHOUDOUFU} is not on PATH (set CHOUDOUFU_BIN to name a build)"; exit 0; fi

export FLOCI_CONTAINER=behold-three-cloud-floci FLOCI_AZ_CONTAINER=behold-three-cloud-floci-az FLOCI_GCP_CONTAINER=behold-three-cloud-floci-gcp
export FLOCI_PORT=4661 FLOCI_AZ_PORT=4662 FLOCI_GCP_PORT=4663
for c in "$FLOCI_CONTAINER" "$FLOCI_AZ_CONTAINER" "$FLOCI_GCP_CONTAINER"; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$c"; then
    echo "$c already exists: a previous run didn't tear down; \`docker rm -f $c\` and re-run" >&2
    exit 1
  fi
done
cleanup() { docker rm -f "$FLOCI_CONTAINER" "$FLOCI_AZ_CONTAINER" "$FLOCI_GCP_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

export AWS_ENDPOINT_URL="http://localhost:$FLOCI_PORT" AZURE_ENDPOINT_URL="http://localhost:$FLOCI_AZ_PORT" GCP_ENDPOINT_URL="http://localhost:$FLOCI_GCP_PORT"

echo "→ copy example-three-cloud to $TARGET and install its chant"
mkdir -p "$TARGET"
tar -C example-three-cloud --exclude node_modules --exclude .front-door --exclude export --exclude .terraform --exclude .tofu-records -cf - . | tar -C "$TARGET" -xf -
npm --prefix "$TARGET" install --no-audit --no-fund --silent

echo "→ boot the emulators under scratch names, choudoufu init in azure"
bash "$TARGET/scripts/emulators-up.sh"

echo "→ plan the four members into one change set"
( cd "$TARGET" && ./node_modules/.bin/tsx scripts/front-door.ts plan --out "$WORK/change-set.json" ) | tee "$WORK/plan.log"

echo "→ read the change set"
# The check runs inside the copy, so it imports the chant the copy installed.
cat > "$TARGET/check-change-set.mts" <<'TS'
import { readFileSync } from "node:fs";
import { verifyChangeSetDigest } from "@intentius/chant/change-set";

const doc = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  console.error(JSON.stringify(doc.members, null, 2).slice(0, 2000));
  process.exit(1);
};
const ok = (m: string) => console.log(`  ✓ ${m}`);
const by: Record<string, any> = Object.fromEntries(doc.members.map((m: any) => [m.member, m]));
const said = (m: any) => `planner ${m.planner}, status ${m.status}${m.error ? `: ${m.error}` : ""}`;

if (JSON.stringify(Object.keys(by).sort()) !== JSON.stringify(["aws", "azure", "dns", "gcp"])) fail(`members are ${Object.keys(by).join(", ")}, not aws, azure, dns and gcp`);
ok("four members in one document");
if (by.azure.planner !== "choudoufu" || by.azure.status !== "planned") fail(`azure is ${said(by.azure)}`);
ok("azure is a choudoufu part, planned");
for (const m of ["dns", "aws", "gcp"]) if (by[m].planner !== "chant" || by[m].status !== "planned") fail(`${m} is ${said(by[m])}`);
ok("dns, aws and gcp are chant parts beside it, planned");
if (typeof by.azure.nativeDigest !== "string" || !by.azure.nativeDigest) fail("azure carries no nativeDigest (choudoufu's root digest)");
if (typeof by.azure.planDigest !== "string" || !by.azure.planDigest) fail("azure carries no planDigest");
ok(`azure binds planDigest ${by.azure.planDigest}, choudoufu root digest ${by.azure.nativeDigest}`);
const app = doc.entries.find((e: any) => e.member === "azure" && e.address === "azurerm_container_app.web");
if (!app || app.planner !== "choudoufu" || app.action !== "create") fail(`azure has no create of azurerm_container_app.web (${JSON.stringify(app)})`);
ok("the estate's container app is a create in azure's part");
if (!doc.entries.some((e: any) => e.member === "dns")) fail("dns has no entries");
ok("dns has entries of its own");
if (!verifyChangeSetDigest(doc)) fail(`the document digest ${doc.digest} does not verify`);
ok(`one digest over all four parts: ${doc.digest}`);
TS
( cd "$TARGET" && ./node_modules/.bin/tsx check-change-set.mts "$WORK/change-set.json" )

echo "three-cloud change-set e2e: all green"
