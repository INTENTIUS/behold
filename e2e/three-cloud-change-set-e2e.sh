#!/usr/bin/env bash
# INTENTIUS/choudoufu#2246 (H3): the three-cloud demo's change set, with the
# Azure site planned by choudoufu. The bundled example is copied out, its
# emulators booted under scratch names, and `scripts/front-door.ts plan`
# composes one change set over the four members: `chant lifecycle plan` for
# dns and gcp, chant's choudoufuPlanSet (`choudoufu live-plan-set`) for the
# azure estate, and `plunge preview` for the aws program (behold#1000; plunge
# is the fake in e2e/fixtures/multi-engine-demo/bin, which answers from
# hand-written fixtures and never applies). Asserted from the document the
# step writes, never its exit code:
#
#   1. four members under one document digest: azure's part has planner
#      choudoufu and aws's pulumi, beside dns and gcp with planner chant, all
#      planned;
#   2. azure's part carries choudoufu's root digest as nativeDigest, and its
#      entries are the estate's own (the container app is a create on a
#      fresh floci-az);
#   3. the document's digest verifies (verifyChangeSetDigest), so one gate
#      over it binds every part.
#
# INTENTIUS/chant#4455 (C5): dns reads azure's azureEndpoint through chant
# (memberOutputsComponent("azure"), stackOutput("azure", "azureEndpoint")).
# The copy is committed, a change to azure/site.tf committed on top, and
# `scripts/front-door.ts pr-plan-dns` runs dns's pull-request plan of that
# change. On a fresh floci-az azure's plan creates the Container App, so
# azureEndpoint is known only after azure applies. Asserted from pr-plan.json
# and change-set.json:
#
#   4. the change names azure (dns's terraform.roots.azure), so the azure
#      component and records are both planned;
#   5. records's step lists azure under its unresolved inputs: the report
#      lists azure.azureEndpoint under its unknownInputs and its reads name it
#      unknown, and its cfn-deploy part is either a hole that says `inputs
#      from azure`, or, on a chant that previews a stack with an input still
#      unknown (chant#4423's covered rounds, chant main), a preview with
#      entries and no hole;
#   6. the azure#outputs part has a hole naming azure.azureEndpoint.
#
# The example needs a chant with member-outputs (chant#4455) and the pulumi
# lexicon (chant#4453), which no release has yet: link chant main's, built,
# e.g. BEHOLD_E2E_CHANT_LINK="/path/to/chant/packages/core
# /path/to/chant/lexicons/terraform /path/to/chant/lexicons/pulumi". dns's
# components import them, so without them the whole script skips, with the
# reason. e2e/multi-engine-demo-e2e.sh asserts the rest of behold#1000: the
# composed graph, the drift colours and a moved part refusing the set.
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
# The azure part is a choudoufu set plan, which needs choudoufu v0.22.0 or
# newer (chant's MIN_CHOUDOUFU_WAVES_VERSION); a dev build names no release
# and is let through, as chant lets it through.
CHOUDOUFU_VERSION=$("$CHOUDOUFU" version 2>/dev/null | sed -n 's/^choudoufu v\([0-9][0-9.]*\).*/\1/p' | head -1)
if [ -n "$CHOUDOUFU_VERSION" ] && [ "$(printf '%s\n0.22.0\n' "$CHOUDOUFU_VERSION" | sort -V | head -1)" != 0.22.0 ]; then
  echo "FAIL: $(command -v "$CHOUDOUFU") is choudoufu v$CHOUDOUFU_VERSION, older than v0.22.0, which the azure part's set plan needs; set CHOUDOUFU_BIN to a build of choudoufu main" >&2
  exit 1
fi

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
tar -C example-three-cloud --exclude node_modules --exclude .front-door --exclude export --exclude .terraform --exclude .tofu-records \
  --exclude .plunge --exclude stack-export.json --exclude Pulumi.local.yaml -cf - . | tar -C "$TARGET" -xf -
npm --prefix "$TARGET" install --no-audit --no-fund --silent
# dns's components import member-outputs, so a chant that has it is linked
# before anything loads them.
for dir in ${BEHOLD_E2E_CHANT_LINK:-}; do
  name=$(node -p "require('$dir/package.json').name")
  rm -rf "$TARGET/node_modules/$name"
  mkdir -p "$(dirname "$TARGET/node_modules/$name")"
  ln -s "$dir" "$TARGET/node_modules/$name"
done
if [ ! -f "$TARGET/node_modules/@intentius/chant/src/components/verbs/member-outputs.ts" ] || [ ! -f "$TARGET/node_modules/@intentius/chant-lexicon-pulumi/workspace-kinds.json" ]; then
  echo "skip: the copy has no chant with member-outputs (chant#4455) or no @intentius/chant-lexicon-pulumi, which dns's components import; set BEHOLD_E2E_CHANT_LINK to chant main's packages/core, lexicons/terraform and lexicons/pulumi"
  exit 0
fi
# The aws member's engine: the fake plunge, for front-door's calls and chant's.
# The export stands where a live apply-aws writes it.
export PATH="$PWD/e2e/fixtures/multi-engine-demo/bin:$PATH" PLUNGE_BIN="$PWD/e2e/fixtures/multi-engine-demo/bin/plunge"
cp e2e/fixtures/multi-engine-demo/aws-stack-export.json "$TARGET/aws/stack-export.json"

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
if (by.aws.planner !== "pulumi" || by.aws.status !== "planned") fail(`aws is ${said(by.aws)}`);
ok("aws is a pulumi part (plunge preview), planned");
for (const m of ["dns", "gcp"]) if (by[m].planner !== "chant" || by[m].status !== "planned") fail(`${m} is ${said(by[m])}`);
ok("dns and gcp are chant parts beside them, planned");
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

echo "→ commit the copy, then a change to azure/ on top of it"
git -C "$TARGET" init -q -b main
echo node_modules/ >> "$TARGET/.git/info/exclude"
git -C "$TARGET" -c user.name=e2e -c user.email=e2e@three-cloud.test add -A
git -C "$TARGET" -c user.name=e2e -c user.email=e2e@three-cloud.test commit -q -m base
BASE=$(git -C "$TARGET" rev-parse HEAD)
printf '\n# chant#4455 e2e: a change to the azure estate\n' >> "$TARGET/azure/site.tf"
git -C "$TARGET" -c user.name=e2e -c user.email=e2e@three-cloud.test commit -q -am "azure: a change"

echo "→ build dns's template, then plan dns's pull request"
( cd "$TARGET/dns" && ../node_modules/.bin/tsx ../scripts/front-door.ts build-dns )
( cd "$TARGET" && ./node_modules/.bin/tsx scripts/front-door.ts pr-plan-dns --base "$BASE" --out "$WORK/pr" ) | tee "$WORK/pr-plan.log"

echo "→ read dns's pull-request plan"
cat > "$TARGET/check-dns-pr-plan.mts" <<'TS'
import { readFileSync } from "node:fs";

const dir = process.argv[2]!;
const report = JSON.parse(readFileSync(`${dir}/pr-plan.json`, "utf8"));
const doc = JSON.parse(readFileSync(`${dir}/change-set.json`, "utf8"));
const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  console.error(JSON.stringify(report.members, null, 2).slice(0, 2000));
  console.error(JSON.stringify(doc.members, null, 2).slice(0, 2000));
  process.exit(1);
};
const ok = (m: string) => console.log(`  ✓ ${m}`);

const components = new Set(report.members.map((m: any) => m.component));
if (!components.has("azure") || !components.has("records")) fail(`planned components are ${[...components].join(", ")}, not azure and records`);
ok("the change to azure/ planned the azure component and records");

const records = report.members.filter((m: any) => m.component === "records");
const deploy = records.find((m: any) => m.member === "local");
if (!deploy) fail("records has no member local (its cfn-deploy step's stack)");
if (!(deploy.unknownInputs ?? []).includes("azure.azureEndpoint")) fail(`records's unknownInputs are ${JSON.stringify(deploy.unknownInputs)}, without azure.azureEndpoint`);
ok("records lists azure.azureEndpoint under its unknownInputs");
const read = (deploy.reads ?? []).find((r: any) => r.upstream === "azure");
if (!read || !(read.unknown ?? []).includes("azureEndpoint")) fail(`records's reads of azure are ${JSON.stringify(read)}, without azureEndpoint unknown`);
ok("records's reads name azure's azureEndpoint unknown");

const part = doc.members.find((m: any) => m.member === "local");
if (!part) fail("the change set has no part for local (records's cfn-deploy)");
const hole = (part.holes ?? []).find((h: any) => typeof h.reason === "string" && /inputs from (\S+, )*azure\b/.test(h.reason));
const previewed = (part.holes ?? []).length === 0 && doc.entries.some((e: any) => e.member === "local");
if (hole) ok(`records's step lists azure under its unresolved inputs: ${hole.reason}`);
else if (previewed) ok(`records's cfn-deploy is previewed with azure.azureEndpoint unknown: ${doc.entries.filter((e: any) => e.member === "local").length} entries, no hole`);
else fail(`records's cfn-deploy part has neither a hole naming azure nor a preview (${JSON.stringify(part.holes)})`);

const outputs = doc.members.find((m: any) => m.member === "azure#outputs");
if (!outputs) fail("the change set has no azure#outputs part");
if (!(outputs.holes ?? []).some((h: any) => h.address === "azure.azureEndpoint")) fail(`azure#outputs has no hole on azure.azureEndpoint (${JSON.stringify(outputs.holes)})`);
ok("azure#outputs has a hole on azure.azureEndpoint");
TS
( cd "$TARGET" && ./node_modules/.bin/tsx check-dns-pr-plan.mts "$WORK/pr" )

echo "three-cloud change-set e2e: all green"
