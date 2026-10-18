/**
 * #682: a throwaway workspace with a resource shipped through a gate, to read
 * the why chain (`trace`, chant#4023) from, for the real-chant test and for
 * recording src/__fixtures__/why-trace/.
 *
 * Member `delivery` is the reader conformance workspace's chant member (its
 * local lexicon declares `delivery/appService` in delivery/src/app.ts), and
 * the workspace declares the decision and work kinds. Two commits:
 *
 *  - BASE adds the workspace and work item W-001 (constrains
 *    delivery/src/app.ts). No trailer, no tag.
 *  - LINKED changes app.ts with `Chant-Record: work:W-001`, and is tagged
 *    ci/green.
 *
 * On chant/lifecycle under `_members/delivery/`: release v1 cut from LINKED
 * by alice; the release gate `prod-release` resolved by bob on the cli for
 * v1 in prod, bound to a change set stored under its plan digest (the one
 * src/__fixtures__/change-set-overlay/ holds, which verifies against its
 * digest); a prod deploy of v1 admitted by that resolution; and a plain
 * staging deploy of LINKED that names no release and no gate.
 *
 * chant refuses a release file whose content does not hash to its name, and
 * the commit shas here are not fixed (the files come from the installed
 * chant package), so the release digest is computed when the workspace is
 * made, with the installed chant's `makeRelease`. That is the one use of
 * chant's library, and it writes a fixture: nothing behold reads goes
 * through it.
 *
 * Test support only: nothing in the server imports it. Every git call is
 * made in the directory given, and nothing outside it is touched.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFORMANCE_FIXTURE_DIR } from "@intentius/chant/workspace/conformance";
import { makeRelease } from "@intentius/chant/lifecycle/release-store";

export const NODE = "delivery/appService";
export const RELEASE_LABEL = "v1";
/** The image the release carries. */
export const IMAGE = `sha256:${createHash("sha256").update("the app image").digest("hex")}`;
export const GATE_AT = "2026-10-16T10:30:00.000Z";
export const PROD_AT = "2026-10-16T10:40:00.000Z";
export const STAGING_AT = "2026-10-16T09:30:00.000Z";

export interface TraceWorkspace {
  root: string;
  /** The commit that adds the workspace: no trailer, no tag. */
  base: string;
  /** The commit that names W-001, is green, and v1 is cut from. */
  linked: string;
  releaseDigest: string;
  /** The change set the release gate binds (its plan digest). */
  changeSet: string;
}

const W001 = `---\n${JSON.stringify({ schema: 1, id: "W-001", title: "Serve the app on 8081", state: "open", implements: [], needs: [], constrains: ["path:delivery/src/app.ts"], evidence: [], opened_on: "2026-10-16", source: { kind: "workspace", member: "delivery" }, supersedes: [] }, null, 2)}\n---\n\n# W-001\n`;

const git = (cwd: string, args: string[], input?: string): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "user.name=behold", "-c", "user.email=behold@localhost", ...args], { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();

/**
 * Make the workspace in `scratch/repo` and return it. With `chant`, the
 * project's chant is a shim at `version` that runs that binary, and whose
 * library is that chant's own source, so the member's lexicon builds against
 * the chant that reads it.
 */
export function makeTraceWorkspace(scratch: string, opts: { chant?: string; version?: string } = {}): TraceWorkspace {
  const root = join(scratch, "repo");
  git(scratch, ["init", "-q", "-b", "main", root]);
  cpSync(join(CONFORMANCE_FIXTURE_DIR, "delivery"), join(root, "delivery"), { recursive: true });
  cpSync(join(CONFORMANCE_FIXTURE_DIR, "decisions"), join(root, "decisions"), { recursive: true });
  const writerWork = join(CONFORMANCE_FIXTURE_DIR, "..", "__writer_fixture__", "work");
  mkdirSync(join(root, "work"));
  for (const f of ["work.kind.mjs", "work.schema.json"]) cpSync(join(writerWork, f), join(root, "work", f));
  writeFileSync(join(root, "work", "W-001-serve-on-8081.md"), W001);
  writeFileSync(
    join(root, "chant.workspace.json"),
    `${JSON.stringify({ name: "shop", schema: 1, members: [{ name: "delivery", dir: "delivery", kind: "chant", because: "the app and its component" }], records: [{ kind: "decisions/decision.kind.mjs" }, { kind: "work/work.kind.mjs" }] }, null, 2)}\n`,
  );
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "the shop and W-001"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  const app = join(root, "delivery", "src", "app.ts");
  writeFileSync(app, readFileSync(app, "utf8").replace("port: 8080", "port: 8081"));
  git(root, ["commit", "-q", "-am", "serve the app on 8081", "--trailer", "Chant-Record: work:W-001"]);
  const linked = git(root, ["rev-parse", "HEAD"]);
  git(root, ["tag", `ci/green/${linked}`, linked]);

  const release = makeRelease({ member: "delivery", commit: linked, artifactDigests: [{ component: "app", kind: "image", path: "app.tar", digest: IMAGE }], targets: [{ env: "prod", templates: [], params: [] }, { env: "staging", templates: [], params: [] }] });
  const stored = (JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "change-set-overlay", "change-set-show.json"), "utf8")) as { changeSet: { digest: string } }).changeSet;
  const changeSet = stored.digest;
  const file = (digest: string) => `${digest.replace(/:/g, "_")}.json`;
  const lines = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n");
  const blob = (text: string) => git(root, ["hash-object", "-w", "--stdin"], `${text}\n`);
  const tree = (entries: string[]) => git(root, ["mktree"], `${entries.join("\n")}\n`);
  const cut = { version: 1, releaseDigest: release.releaseDigest, label: RELEASE_LABEL, actor: "alice", timestamp: "2026-10-16T10:00:00.000Z", runOrigin: null, signature: null };
  const resolution = { version: 1, kind: "resolution", op: "release", gate: "prod-release", resolvedBy: "bob", origin: "cli", timestamp: GATE_AT, planDigest: changeSet, environment: "prod", releaseDigest: release.releaseDigest };
  const deploy = (env: string, runId: string, timestamp: string, more: Record<string, unknown>) => ({ version: 1, component: "app", env, digest: IMAGE, gitSha: linked, runId, timestamp, actor: "ci", ...more });
  const releases = tree([`100644 blob ${blob(JSON.stringify(release))}\t${file(release.releaseDigest)}`, `100644 blob ${blob(lines([cut]))}\tcuts.jsonl`]);
  const gates = tree([`100644 blob ${blob(lines([resolution]))}\trelease.jsonl`]);
  const changeSets = tree([`100644 blob ${blob(JSON.stringify(stored))}\t${file(changeSet)}`]);
  const prod = tree([`100644 blob ${blob(lines([deploy("prod", "run-9", PROD_AT, { releaseDigest: release.releaseDigest, approver: "bob", admission: { op: "release", gate: "prod-release", resolvedAt: GATE_AT } })]))}\treleases.jsonl`]);
  const staging = tree([`100644 blob ${blob(lines([deploy("staging", "run-1", STAGING_AT, {})]))}\treleases.jsonl`]);
  const member = tree([`040000 tree ${changeSets}\t_change-sets`, `040000 tree ${gates}\t_gates`, `040000 tree ${releases}\t_releases`, `040000 tree ${prod}\tprod`, `040000 tree ${staging}\tstaging`]);
  const top = tree([`040000 tree ${tree([`040000 tree ${member}\tdelivery`])}\t_members`]);
  git(root, ["update-ref", "refs/heads/chant/lifecycle", git(root, ["commit-tree", top, "-m", "ledger"])]);

  if (opts.chant) {
    const pkg = join(root, "node_modules", "@intentius", "chant");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    // The lexicon imports @intentius/chant, so the shim's library is the source of the chant it runs.
    const source = join(dirname(dirname(opts.chant)), "src", "index.ts");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/chant", version: opts.version ?? "0.124.29", type: "module", main: "index.ts", bin: { chant: "bin/chant" } }));
    writeFileSync(join(pkg, "index.ts"), `export * from ${JSON.stringify(source)};\n`);
    writeFileSync(join(pkg, "bin", "chant"), `#!/bin/sh\nexec ${JSON.stringify(opts.chant)} "$@"\n`);
    chmodSync(join(pkg, "bin", "chant"), 0o755);
  }
  return { root, base, linked, releaseDigest: release.releaseDigest, changeSet };
}
