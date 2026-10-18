/**
 * #683: a throwaway chant workspace with feature flags (chant#4024), for the
 * real-chant test and for recording src/__fixtures__/feature-flags/.
 *
 * Member `web` promotes staging then prod and declares two boolean build
 * parameters. Three record kinds, written here in the shape chant ships them
 * (the flag kind and schema are chant's reference copies, the decision and
 * work kinds are cut down to what a flag reads):
 *
 *  - decisions d-001 (confirmed) and d-002 (only decided);
 *  - work items W-001, implementing d-001 and done, and W-002, implementing
 *    d-002 and in progress;
 *  - the flag `new-checkout` (owner alice, W-002, parameter newCheckout): on
 *    in staging, off in prod;
 *  - the flag `old-banner` (owner bob, W-001, parameter banner): on in both,
 *    and due for removal, since every decision W-001 implements is confirmed
 *    (chant's stale-flag lint, WSP118).
 *
 * One trunk commit, made with fixed content, author and date. On
 * chant/lifecycle under `_members/web/`, a release gate (op `release`, gate
 * `promote`) waits in staging on that commit, binding the change set chant
 * plans for a release that turns new-checkout on there: one `chant:component`
 * entry for component `web` with the attribute `param:newCheckout`, false
 * before and true after, and no graph node (a component is no node of the
 * graph). The stored document is src/__fixtures__/feature-flags/
 * stored-change-set.json, composed with chant main's own composeChangeSet
 * so its digest verifies.
 *
 * Test support only: nothing in the server imports it. Every git call is
 * made in the directory given, and nothing outside it is touched.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The trunk commit. */
export const FLAG_COMMIT = "07b5fa8e574ece9a0780b8aec23be492e82154eb";
/** The stored change set the staging gate binds, as chant composed it. */
export const FLAG_CHANGE_SET = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "feature-flags", "stored-change-set.json"), "utf8")) as Record<string, unknown> & { digest: string; releaseDigest: string };
/** The release gate's key. */
export const FLAG_GATE = "web/release/promote";

const git = (cwd: string, args: string[], input?: string, env?: Record<string, string>): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", input, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] }).trim();

const DECISION_KIND = `export const recordKind = {
  name: "decision",
  location: { dir: ".", match: "^d-[0-9]{3}-.+\\\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:test:decision:1", path: "decision.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["proposed", "decided", "confirmed", "superseded"],
  closedStates: ["confirmed", "superseded"],
  supersedes: { field: "supersedes" },
};
`;
const DECISION_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:test:decision:1",
  type: "object",
  required: ["id", "state"],
  properties: { id: { type: "string" }, state: { type: "string" }, supersedes: { type: "array", items: { type: "string" } } },
};
const WORK_KIND = `export const recordKind = {
  name: "work",
  location: { dir: ".", match: "^W-[0-9]{3,}-.+\\\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:test:work:1", path: "work.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["open", "in-progress", "done", "dropped"],
  closedStates: ["done", "dropped"],
  work: { needs: "needs", implements: "implements", decisions: "../decisions/decision.kind.mjs", open: "open", done: "done", closedOn: "closed_on" },
};
`;
const WORK_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:test:work:1",
  type: "object",
  required: ["id", "state", "implements", "needs"],
  properties: { id: { type: "string" }, state: { type: "string" }, implements: { type: "array", items: { type: "string" } }, needs: { type: "array", items: { type: "string" } }, closed_on: { type: "string" } },
};
/** chant's reference flag kind (packages/core/src/workspace/reference-kinds/flag), comments left out. */
const FLAG_KIND = `export const recordKind = {
  name: "flag",
  location: { dir: ".", match: "^[a-z][a-z0-9-]{0,62}\\\\.flag\\\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:flag:1", path: "flag.schema.json" },
  idField: "id",
  flag: {
    member: "member",
    param: "param",
    owner: "owner",
    values: "values",
    work: { field: "work", kind: "../work/work.kind.mjs" },
  },
};
`;
/** chant's reference flag schema, its descriptions left out. */
const FLAG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:intentius:chant:flag:1",
  type: "object",
  additionalProperties: false,
  patternProperties: { "^x-": {} },
  required: ["schema", "id", "owner", "work", "member", "param", "values"],
  properties: {
    schema: { const: 1 },
    id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" },
    title: { type: "string" },
    owner: { type: "string", minLength: 1 },
    work: { type: "string", minLength: 1 },
    member: { type: "string", minLength: 1 },
    param: { type: "string", minLength: 1 },
    values: { type: "object", propertyNames: { pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }, additionalProperties: { type: ["string", "number", "boolean"] } },
  },
};

const front = (data: Record<string, unknown>, body: string) => `---\n${JSON.stringify(data, null, 2)}\n---\n\n${body}\n`;

const FILES: Record<string, string> = {
  "chant.workspace.json": `{ "name": "acme", "schema": 1, "minReader": "0.108.0",
  "members": [{ "name": "web", "dir": "web", "kind": "chant", "because": "the app" }],
  "records": [{ "kind": "decisions/decision.kind.mjs" }, { "kind": "work/work.kind.mjs" }, { "kind": "flags/flag.kind.mjs" }] }
`,
  "web/chant.config.ts": `export default {
  environments: ["staging", "prod"],
  buildParams: {
    newCheckout: { type: "boolean", default: false },
    banner: { type: "boolean", default: false },
  },
};
`,
  "decisions/decision.kind.mjs": DECISION_KIND,
  "decisions/decision.schema.json": JSON.stringify(DECISION_SCHEMA, null, 2) + "\n",
  "decisions/d-001-the-banner.md": front({ id: "d-001", state: "confirmed", supersedes: [] }, "# d-001"),
  "decisions/d-002-the-checkout.md": front({ id: "d-002", state: "decided", supersedes: [] }, "# d-002"),
  "work/work.kind.mjs": WORK_KIND,
  "work/work.schema.json": JSON.stringify(WORK_SCHEMA, null, 2) + "\n",
  "work/W-001-the-banner.md": front({ id: "W-001", state: "done", implements: ["d-001"], needs: [], closed_on: "2026-09-30" }, "# W-001"),
  "work/W-002-the-checkout.md": front({ id: "W-002", state: "in-progress", implements: ["d-002"], needs: [] }, "# W-002"),
  "flags/flag.kind.mjs": FLAG_KIND,
  "flags/flag.schema.json": JSON.stringify(FLAG_SCHEMA, null, 2) + "\n",
  "flags/new-checkout.flag.md": front(
    { schema: 1, id: "new-checkout", owner: "alice", work: "W-002", member: "web", param: "newCheckout", values: { staging: true, prod: false } },
    "The new checkout flow, off in prod until W-002 is done.",
  ),
  "flags/old-banner.flag.md": front({ schema: 1, id: "old-banner", owner: "bob", work: "W-001", member: "web", param: "banner", values: { staging: true, prod: true } }, "The old banner, on everywhere."),
  ".gitignore": "node_modules\n",
};

/**
 * Make the workspace in `scratch/repo` and return its root. With `chant`, the
 * project's chant is a shim at `version` that runs that binary.
 */
export function makeFlagWorkspace(scratch: string, opts: { chant?: string; version?: string } = {}): string {
  const root = join(scratch, "repo");
  git(scratch, ["init", "-q", "-b", "main", root]);
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const at = "2026-10-01T10:00:00Z";
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "flags"], undefined, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
  const sha = git(root, ["rev-parse", "HEAD"]);
  if (sha !== FLAG_COMMIT) throw new Error(`the fixture's commit came out as ${sha}`);

  // chant/lifecycle under _members/web/: the stored change set and the release gate's pending fact.
  const doc = FLAG_CHANGE_SET;
  const blob = (text: string) => git(root, ["hash-object", "-w", "--stdin"], `${text}\n`);
  const tree = (entries: string[]) => git(root, ["mktree"], `${entries.join("\n")}\n`);
  const pending = { version: 1, kind: "pending", op: "release", gate: "promote", environment: "staging", timestamp: "2026-10-02T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: doc.digest, gitSha: sha, runId: "run-21", releaseDigest: doc.releaseDigest };
  const gates = tree([`100644 blob ${blob(JSON.stringify(pending))}\trelease.jsonl`]);
  const sets = tree([`100644 blob ${blob(JSON.stringify(doc))}\t${doc.digest.replace(/:/g, "_")}.json`]);
  const web = tree([`040000 tree ${gates}\t_gates`, `040000 tree ${sets}\t_change-sets`]);
  const top = tree([`040000 tree ${tree([`040000 tree ${web}\tweb`])}\t_members`]);
  git(root, ["update-ref", "refs/heads/chant/lifecycle", git(root, ["commit-tree", top, "-m", "gate"], undefined, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at })]);

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
