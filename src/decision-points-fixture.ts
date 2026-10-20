/**
 * #472: a throwaway chant workspace with two open decision points, for the
 * real-chant test and for recording src/__fixtures__/decision-points/.
 *
 * Member `web` (directory `web`) and an answer kind (the reference
 * workspace's) whose points file declares `staging-apply`, a noul point a gate
 * asks (INTENTIUS/chant#3170), and `launch-tier`, a choice point nothing gates
 * on. Both questions are asked with the project's chant (`chant workspace
 * points ask`, into the working tree), so both are escalated to people. On
 * chant/lifecycle under `_members/web/`, gate `approve-apply` of op `deploy`
 * waits in staging on the staging-apply question: its pending fact names the
 * question the way a run that reached the gate writes it.
 *
 * Test support only: nothing in the server imports it. Every git and chant
 * call is made in the directory given.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const GATE_POINT = "staging-apply";
export const LOOSE_POINT = "launch-tier";

const AUTHOR = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_AUTHOR_DATE: "2026-10-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T10:00:00Z" };
const git = (cwd: string, args: string[], input?: string): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", input, env: { ...process.env, ...AUTHOR }, stdio: ["pipe", "pipe", "pipe"] }).trim();

/** The reference workspace's answer kind (chant 0.124.31), data only. */
const ANSWER_KIND = `export const recordKind = {
  name: "answer",
  location: { dir: ".", match: "^[a-z][a-z0-9-]*-[0-9a-f]{12}\\\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:point-answer:1", path: "answer.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["escalated", "proposed", "answered"],
  closedStates: ["answered"],
  constrains: { field: "constrains" },
  source: { field: "source" },
  answers: { points: "../decisions/points.json" },
};
`;

const POINTS = {
  points: {
    [GATE_POINT]: {
      title: "Apply this plan to staging",
      question: { type: "noul", instructions: "Should this plan be applied to staging?", criteria: { true: "Apply it.", false: "Do not apply it." } },
      inputs: { "gate.component": "the Op", "gate.name": "the gate", "gate.env": "the environment" },
      deciders: [{ kind: "quorum", count: 2, roles: ["maintainer"] }],
    },
    [LOOSE_POINT]: {
      title: "Which tier the launch goes out on",
      question: { type: "choice", instructions: "Pick the tier the launch goes out on.", criteria: { small: "One region.", large: "Every region." } },
      inputs: { "ask.id": "the launch" },
      deciders: [{ kind: "quorum", count: 1 }],
    },
  },
};

const FILES: Record<string, string> = {
  "chant.workspace.json": `{ "name": "acme", "schema": 1,
  "members": [{ "name": "web", "dir": "web", "kind": "chant", "because": "the app" }],
  "records": [{ "kind": "answers/answer.kind.mjs" }] }
`,
  "web/chant.config.ts": `export default { environments: ["staging", "prod"] };\n`,
  "answers/answer.kind.mjs": ANSWER_KIND,
  "decisions/points.json": JSON.stringify(POINTS, null, 2) + "\n",
  ".gitignore": "node_modules\n",
};

/**
 * Make the workspace in `scratch/repo` and return its root and the gate's
 * question id. `chant` is the binary that asks the questions; it also becomes
 * the project's chant, a shim at `version`.
 */
export function makePointsWorkspace(scratch: string, opts: { chant: string; version?: string }): { root: string; gateQuestion: string } {
  const root = join(scratch, "repo");
  git(scratch, ["init", "-q", "-b", "main", root]);
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  // The answer schema is the one chant ships, as the reference workspace copies it.
  copyFileSync(join(import.meta.dirname, "..", "node_modules", "@intentius", "chant", "src", "workspace", "point-answer.schema.json"), join(root, "answers", "answer.schema.json"));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "workspace"]);

  // Outside CI a question is asked into the working tree.
  const ask = (point: string, inputs: Record<string, string>, subject: string): string => {
    const out = execFileSync(opts.chant, ["workspace", "points", "ask", point, "--inputs", JSON.stringify(inputs), "--subject", subject, "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, CI: "" }, stdio: ["pipe", "pipe", "pipe"] });
    const id = (JSON.parse(out) as { id?: unknown }).id;
    if (typeof id !== "string") throw new Error(`points ask ${point} printed no id: ${out}`);
    return id;
  };
  const gateQuestion = ask(GATE_POINT, { "gate.component": "deploy", "gate.name": "approve-apply", "gate.env": "staging" }, "gate:deploy/approve-apply@staging");
  ask(LOOSE_POINT, { "ask.id": "L-7" }, "L-7");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "questions"]);

  // chant/lifecycle under _members/web/: the gate's pending fact, naming its question (chant#3170).
  const pending = { version: 1, kind: "pending", op: "deploy", gate: "approve-apply", environment: "staging", timestamp: "2026-10-05T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", answer: { point: GATE_POINT, id: gateQuestion, path: `answers/${gateQuestion}.md` } };
  const blob = (text: string) => git(root, ["hash-object", "-w", "--stdin"], `${text}\n`);
  const tree = (entries: string[]) => git(root, ["mktree"], `${entries.join("\n")}\n`);
  const gates = tree([`100644 blob ${blob(JSON.stringify(pending))}\tdeploy.jsonl`]);
  const web = tree([`040000 tree ${gates}\t_gates`]);
  const top = tree([`040000 tree ${tree([`040000 tree ${web}\tweb`])}\t_members`]);
  git(root, ["update-ref", "refs/heads/chant/lifecycle", git(root, ["commit-tree", top, "-m", "gate"])]);

  const pkg = join(root, "node_modules", "@intentius", "chant");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/chant", version: opts.version ?? "0.124.31", main: "index.js", bin: { chant: "bin/chant" } }));
  writeFileSync(join(pkg, "index.js"), "");
  writeFileSync(join(pkg, "bin", "chant"), `#!/bin/sh\nexec ${JSON.stringify(opts.chant)} "$@"\n`);
  chmodSync(join(pkg, "bin", "chant"), 0o755);
  return { root, gateQuestion };
}
