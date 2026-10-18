/**
 * #684: a throwaway chant workspace where two in-flight work items touch one
 * resource, for the real-chant test and for recording
 * src/__fixtures__/collision-marks/.
 *
 * Member `web` (directory `web`) with a decision kind and a work kind cut down
 * to what overlap reads. Decision d-001 is only decided, so the work items
 * W-001 and W-002 that implement it are in flight. Branch `a` changes line 1
 * of web/queue.ts for W-001 and branch `b` changes line 20 of it for W-002
 * (each with a `Chant-Record` trailer); `b` also adds web/other.ts. `m` merges
 * both. On chant/lifecycle under `_members/web/`, a release gate (op
 * `release`, gate `promote`) waits in staging at `m`, binding the stored change
 * set of src/__fixtures__/feature-flags/ with its one entry given the graph
 * node `web/Queue` and the source `web/queue.ts` (the node and source stay
 * outside the digest, so it still verifies). That is the shared address.
 *
 * Test support only: nothing in the server imports it. Every git call is made
 * in the directory given.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DECISION_KIND, DECISION_SCHEMA, FLAG_CHANGE_SET, WORK_KIND, WORK_SCHEMA, front } from "./feature-flags-fixture.ts";

/** The shared entry's graph node, and the file that declares it. */
export const COLLISION_NODE = "web/Queue";
export const COLLISION_SOURCE = "web/queue.ts";
export const COLLISION_ITEMS = ["work:W-001", "work:W-002"] as const;

const AUTHOR = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const git = (cwd: string, args: string[], input?: string, env?: Record<string, string>): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", input, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] }).trim();

const lines = (changed: Record<number, string>) => Array.from({ length: 20 }, (_, i) => changed[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

const FILES: Record<string, string> = {
  "chant.workspace.json": `{ "name": "acme", "schema": 1, "minReader": "0.108.0",
  "members": [{ "name": "web", "dir": "web", "kind": "chant", "because": "the app" }],
  "records": [{ "kind": "decisions/decision.kind.mjs" }, { "kind": "work/work.kind.mjs" }] }
`,
  "web/chant.config.ts": `export default { environments: ["staging", "prod"] };\n`,
  "web/queue.ts": lines({}),
  "decisions/decision.kind.mjs": DECISION_KIND,
  "decisions/decision.schema.json": JSON.stringify(DECISION_SCHEMA, null, 2) + "\n",
  "decisions/d-001-the-queue.md": front({ id: "d-001", state: "decided", supersedes: [] }, "# d-001"),
  "work/work.kind.mjs": WORK_KIND,
  "work/work.schema.json": JSON.stringify(WORK_SCHEMA, null, 2) + "\n",
  "work/W-001-the-queue.md": front({ id: "W-001", state: "in-progress", implements: ["d-001"], needs: [] }, "# W-001"),
  "work/W-002-the-queue-again.md": front({ id: "W-002", state: "in-progress", implements: ["d-001"], needs: [] }, "# W-002"),
  ".gitignore": "node_modules\n",
};

/** Make the workspace in `scratch/repo` and return its root. With `chant`, the project's chant is a shim at `version` that runs that binary. */
export function makeCollisionWorkspace(scratch: string, opts: { chant?: string; version?: string } = {}): string {
  const root = join(scratch, "repo");
  git(scratch, ["init", "-q", "-b", "main", root]);
  const at = (n: number) => ({ ...AUTHOR, GIT_AUTHOR_DATE: `2026-10-0${n}T10:00:00Z`, GIT_COMMITTER_DATE: `2026-10-0${n}T10:00:00Z` });
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "workspace"], undefined, at(1));
  const work = (branch: string, files: Record<string, string>, item: string, n: number) => {
    git(root, ["checkout", "-q", "-b", branch, "main"]);
    for (const [p, t] of Object.entries(files)) writeFileSync(join(root, p), t);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", `work on ${item}`, "--trailer", `Chant-Record: ${item}`], undefined, at(n));
  };
  work("a", { "web/queue.ts": lines({ 1: "a" }) }, "work:W-001", 2);
  work("b", { "web/queue.ts": lines({ 20: "b" }), "web/other.ts": "b\n" }, "work:W-002", 3);
  git(root, ["checkout", "-q", "-b", "m", "a"]);
  git(root, ["merge", "-q", "--no-edit", "b"], undefined, at(4));
  const merged = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "-q", "main"]);

  // chant/lifecycle under _members/web/: the stored change set and the release gate's pending fact.
  const doc = { ...FLAG_CHANGE_SET, entries: (FLAG_CHANGE_SET.entries as Record<string, unknown>[]).map((e) => ({ ...e, node: COLLISION_NODE, source: COLLISION_SOURCE })) } as typeof FLAG_CHANGE_SET;
  const blob = (text: string) => git(root, ["hash-object", "-w", "--stdin"], `${text}\n`);
  const tree = (entries: string[]) => git(root, ["mktree"], `${entries.join("\n")}\n`);
  const pending = { version: 1, kind: "pending", op: "release", gate: "promote", environment: "staging", timestamp: "2026-10-05T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: doc.digest, gitSha: merged, runId: "run-21", releaseDigest: doc.releaseDigest };
  const gates = tree([`100644 blob ${blob(JSON.stringify(pending))}\trelease.jsonl`]);
  const sets = tree([`100644 blob ${blob(JSON.stringify(doc))}\t${doc.digest.replace(/:/g, "_")}.json`]);
  const web = tree([`040000 tree ${gates}\t_gates`, `040000 tree ${sets}\t_change-sets`]);
  const top = tree([`040000 tree ${tree([`040000 tree ${web}\tweb`])}\t_members`]);
  git(root, ["update-ref", "refs/heads/chant/lifecycle", git(root, ["commit-tree", top, "-m", "gate"], undefined, at(5))]);

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
