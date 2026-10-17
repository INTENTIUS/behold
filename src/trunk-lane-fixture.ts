/**
 * #680, #692: a throwaway chant workspace to read the trunk lane from, for
 * the real-chant test and for recording src/__fixtures__/trunk-lane/.
 *
 * Member `web` declares staging then prod (an order that is not alphabetical).
 * Four trunk commits made with fixed content, author and dates, so their
 * shas and the release digests over them are fixed: C1 and C2 green, C3 green
 * then revoked, C4 undecided. On chant/lifecycle under `_members/web/`:
 *
 *  - three releases, each cut once: v1 from C1 with one image digest, v2 from
 *    C2 with the same digest (a config-only release), and v3 from C3 with a
 *    new one, whose cut carries a signature that does not verify;
 *  - deploy records: prod runs v1 (component web), staging runs v2 (web) and
 *    v3 (component api), so staging runs a revoked release;
 *  - two gates pending in prod: the component gate web/promote on C2, whose
 *    plan has a change set stored, and the release gate release/promote for
 *    v3, which chant reads as superseded because v3's commit is revoked.
 *
 * The digests R1 to R3 are chant's computeReleaseDigest over each release,
 * worked out once with chant main and written here, since chant refuses a
 * release file whose content does not hash to its name.
 *
 * Test support only: nothing in the server imports it. Every git call is
 * made in the directory given, and nothing outside it is touched.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const C1 = "6828a7f5b398ea48543fe27c018ba302ce2aba14";
export const C2 = "a14610e4f51778c969efcc77694a360412c34d88";
export const C3 = "9c4250fa1ed203aa9c61eca708c8f0bbf4a06ddd";
export const C4 = "0c7c85ae8cca01463f304a3bd69bc3e977899d5f";
export const R1 = "jcs1-sha256:429be72cf20581436c4ffc74788444602ba3c4b25fd231c65ad41b230d094429";
export const R2 = "jcs1-sha256:6aafbba83be3cb5e1793979cfcc0b0f684a06eb57bca5c3dd3624769ea7ca71e";
export const R3 = "jcs1-sha256:bbdcfcdab12b9c484ab198b570477b0b568f6a43f4265fd6aef7823d563759b2";
/** The image digest v1 and v2 carry, and the one v3 carries. */
export const IMAGE_1 = `sha256:${"a1".repeat(32)}`;
export const IMAGE_3 = `sha256:${"b3".repeat(32)}`;
/** The plan the component gate binds, with a change set stored under it. */
export const DIGEST = "sha256:4b5e57f6eb2f42b9039b3d1e13929295f231749c510cbe341cd68036d9af97e2";
/** The plan the release gate for v3 binds. */
export const RELEASE_PLAN = `sha256:${"c3".repeat(32)}`;

/** When ci tick made the tags, so a revoked tag's `tagged` is fixed too. */
export const TAGGED = "2026-10-05T00:00:00Z";

const git = (cwd: string, args: string[], input?: string, env?: Record<string, string>): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8", input, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] }).trim();

const run = (id: number, conclusion: string) => ({ name: "test", id, conclusion, url: `https://github.com/acme/app/actions/runs/${id}` });

/**
 * Make the workspace in `scratch/repo` and return its root. With `chant`, the
 * project's chant is a shim at `version` that runs that binary.
 */
export function makeLaneWorkspace(scratch: string, opts: { chant?: string; version?: string } = {}): string {
  const root = join(scratch, "repo");
  git(scratch, ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, "web"));
  writeFileSync(
    join(root, "chant.workspace.json"),
    `{ "name": "acme", "schema": 1, "minReader": "0.108.0",
  "members": [{ "name": "web", "dir": "web", "kind": "chant", "because": "the app" }],
  "ci": { "green": { "branch": "main", "window": "3650d", "phases": { "test": ["test"] }, "require": ["test"] } } }
`,
  );
  writeFileSync(join(root, "web", "chant.config.ts"), 'export default { environments: ["staging", "prod"] };\n');
  const shas: string[] = [];
  const messages = ["base", "add the cart", "break the cart", "fix the cart"];
  messages.forEach((msg, i) => {
    const at = `2026-10-0${i + 1}T10:00:00Z`;
    writeFileSync(join(root, "web", "log.txt"), messages.slice(0, i + 1).join("\n") + "\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", msg], undefined, { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
    shas.push(git(root, ["rev-parse", "HEAD"]));
  });
  if (shas.join() !== [C1, C2, C3, C4].join()) throw new Error(`the fixture's commits came out as ${shas.join(", ")}`);

  // The tags chant ci tick makes, with the annotations it writes.
  const tag = (name: string, subject: string, record: unknown, sha: string) => git(root, ["tag", "-a", name, "-m", `${subject}\n\n${JSON.stringify(record)}`, sha], undefined, { GIT_COMMITTER_DATE: TAGGED });
  [C1, C2, C3].forEach((sha, i) =>
    tag(`ci/green/${sha}`, "ci: every required phase passed (test)", { schema: 1, tag: "green", commit: sha, branch: "main", at: "2026-10-05T00:00:00Z", phases: { test: [run(101 + i, "success")] } }, sha),
  );
  tag(`ci/revoked/${C3}`, "ci: phase test failed in test (failure)", { schema: 1, tag: "revoked", commit: C3, branch: "main", at: "2026-10-05T00:00:00Z", phase: "test", run: run(113, "failure") }, C3);

  const targets = [{ env: "prod", templates: [], params: [] }, { env: "staging", templates: [], params: [] }];
  const release = (commit: string, digest: string, image: string) => ({ version: 1, releaseDigest: digest, member: "web", commit, artifactDigests: [{ component: "web", kind: "image", path: "web/Dockerfile", digest: image }], targets });
  const cut = (digest: string, label: string, at: string, signature: string | null = null) => ({ version: 1, releaseDigest: digest, label, actor: "github:alice", timestamp: at, runOrigin: null, signature });
  const deploy = (env: string, component: string, gitSha: string, releaseDigest: string, more: Record<string, unknown>) => ({ version: 1, component, env, digest: DIGEST, gitSha, actor: "ci", releaseDigest, ...more });
  const lines = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n");
  const blob = (text: string) => git(root, ["hash-object", "-w", "--stdin"], `${text}\n`);
  const tree = (entries: string[]) => git(root, ["mktree"], `${entries.join("\n")}\n`);
  const file = (name: string) => name.replace(/:/g, "_");
  const releases = tree([
    `100644 blob ${blob(JSON.stringify(release(C1, R1, IMAGE_1)))}\t${file(R1)}.json`,
    `100644 blob ${blob(JSON.stringify(release(C2, R2, IMAGE_1)))}\t${file(R2)}.json`,
    `100644 blob ${blob(JSON.stringify(release(C3, R3, IMAGE_3)))}\t${file(R3)}.json`,
    `100644 blob ${blob(lines([cut(R1, "v1", "2026-10-02T09:00:00Z"), cut(R2, "v2", "2026-10-03T09:00:00Z"), cut(R3, "v3", "2026-10-04T09:00:00Z", "-----BEGIN SSH SIGNATURE-----\nbm90IGEgc2lnbmF0dXJl\n-----END SSH SIGNATURE-----")]))}\tcuts.jsonl`,
  ]);
  const prod = tree([`100644 blob ${blob(lines([deploy("prod", "web", C1, R1, { runId: "run-1", timestamp: "2026-10-02T12:00:00Z", approver: "github:alice" })]))}\treleases.jsonl`]);
  const staging = tree([
    `100644 blob ${blob(lines([deploy("staging", "web", C2, R2, { runId: "run-2", timestamp: "2026-10-03T12:00:00Z" }), deploy("staging", "api", C3, R3, { runId: "run-3", timestamp: "2026-10-04T12:00:00Z" })]))}\treleases.jsonl`,
  ]);
  const pending = { version: 1, kind: "pending", op: "web", gate: "promote", environment: "prod", timestamp: "2026-10-04T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: DIGEST, gitSha: C2, runId: "run-9" };
  const releaseGate = { version: 1, kind: "pending", op: "release", gate: "promote", environment: "prod", timestamp: "2026-10-04T13:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: RELEASE_PLAN, gitSha: C3, runId: "run-12", releaseDigest: R3 };
  const gates = tree([`100644 blob ${blob(JSON.stringify(releaseGate))}\trelease.jsonl`, `100644 blob ${blob(JSON.stringify(pending))}\tweb.jsonl`]);
  // Only the name matters to status: a change set is stored under the plan.
  const changeSets = tree([`100644 blob ${blob("{}")}\t${file(DIGEST)}.json`]);
  const web = tree([`040000 tree ${changeSets}\t_change-sets`, `040000 tree ${gates}\t_gates`, `040000 tree ${releases}\t_releases`, `040000 tree ${prod}\tprod`, `040000 tree ${staging}\tstaging`]);
  const top = tree([`040000 tree ${tree([`040000 tree ${web}\tweb`])}\t_members`]);
  git(root, ["update-ref", "refs/heads/chant/lifecycle", git(root, ["commit-tree", top, "-m", "lane"])]);

  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  if (opts.chant) {
    const pkg = join(root, "node_modules", "@intentius", "chant");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/chant", version: opts.version ?? "0.124.29", main: "index.js", bin: { chant: "bin/chant" } }));
    writeFileSync(join(pkg, "index.js"), "");
    writeFileSync(join(pkg, "bin", "chant"), `#!/bin/sh\nexec ${JSON.stringify(opts.chant)} "$@"\n`);
    chmodSync(join(pkg, "bin", "chant"), 0o755);
  }
  return root;
}
