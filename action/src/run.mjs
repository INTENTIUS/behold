/**
 * The three things the action does, each taking its inputs and its effects as
 * arguments: `readChanged` (read two revisions, write the SVG, the JSON and
 * the comment body), `report` (job summary and the one comment) and
 * `postComment` (the second workflow of the fork recipe).
 *
 * Nothing here runs the checked-out code. behold reads files out of git
 * (`git archive` of each commit); a Terraform file is parsed, never executed.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { commentBody, jobSummary, SUMMARY_LIMIT_BYTES } from "./compose.mjs";
import { findComment, githubClient, updateIfPresent, upsertComment } from "./github.mjs";

export const DEFAULT_MARKER = "behold:changed";
/** GitHub's comment ceiling is reported as 65,536; stay under 60,000 as FORGE_BUDGETS.github does (e2e/forge-limits/README.md). */
const COMMENT_CHARS = 60_000;

/** Inputs from the environment the composite action sets (`INPUT_<NAME>`). */
export function readInputs(env) {
  const get = (k, d = "") => (env[`INPUT_${k}`] ?? "").trim() || d;
  return {
    token: get("GITHUB_TOKEN") || env.GITHUB_TOKEN || "",
    base: get("BASE"),
    head: get("HEAD"),
    path: get("PATH", "."),
    depth: get("DEPTH"),
    budget: get("BUDGET"),
    theme: get("THEME"),
    comment: get("COMMENT", "auto"),
    marker: get("MARKER", DEFAULT_MARKER),
    version: get("BEHOLD_VERSION", "latest"),
    out: get("OUTPUT_DIR", join(env.RUNNER_TEMP ?? ".", "behold-changed")),
    failOnError: get("FAIL_ON_ERROR", "true") !== "false",
    module: get("BEHOLD_MODULE"),
    handoffDir: get("HANDOFF_DIR"),
  };
}

/** The pull request the run belongs to, from the event payload. */
export function pullRequestOf(env, readFile = (p) => readFileSync(p, "utf8")) {
  if (!env.GITHUB_EVENT_PATH) return undefined;
  let event;
  try {
    event = JSON.parse(readFile(env.GITHUB_EVENT_PATH));
  } catch {
    return undefined;
  }
  const pr = event.pull_request;
  if (!pr) return undefined;
  return {
    number: pr.number ?? event.number,
    base: pr.base?.sha,
    head: pr.head?.sha,
    fork: !!pr.head?.repo && pr.head.repo.full_name !== env.GITHUB_REPOSITORY,
  };
}

function appendSummary(env, text) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  if (Buffer.byteLength(text) > SUMMARY_LIMIT_BYTES) text = `${text.slice(0, SUMMARY_LIMIT_BYTES - 200)}\n\n(summary cut at 1 MiB)\n`;
  appendFileSync(env.GITHUB_STEP_SUMMARY, text);
}

function setOutputs(env, outputs) {
  if (!env.GITHUB_OUTPUT) return;
  for (const [k, v] of Object.entries(outputs)) appendFileSync(env.GITHUB_OUTPUT, `${k}=${String(v).replace(/\r?\n/g, " ")}\n`);
}

const git = (root, args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

/** Bring a commit in with a one-commit fetch when the clone lacks it. */
export function ensureCommit(root, sha, run = git) {
  if (run(root, ["cat-file", "-e", `${sha}^{commit}`]).status === 0) return true;
  run(root, ["fetch", "--no-tags", "--depth=1", "origin", sha]);
  return run(root, ["cat-file", "-e", `${sha}^{commit}`]).status === 0;
}

/**
 * Load `@intentius/behold-graph`: a module path when one is given (tests, a
 * local build), else an install of the named version into a scratch directory.
 */
export async function loadBehold({ module, version, scratch }) {
  if (module) {
    const mod = await import(module.startsWith("/") ? `file://${module}` : module);
    return { ...mod, version: mod.version ?? "action" };
  }
  mkdirSync(scratch, { recursive: true });
  const spec = `@intentius/behold-graph@${version}`;
  const r = spawnSync("npm", ["install", "--prefix", scratch, "--no-audit", "--no-fund", "--loglevel=error", spec], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`could not install ${spec}: ${r.stderr.trim() || r.stdout.trim()}`);
  const pkgDir = join(scratch, "node_modules", "@intentius", "behold-graph");
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const mod = await import(`file://${join(pkgDir, "dist", "index.js")}`);
  return { ...mod, version: pkg.version };
}

class ReadFailed extends Error {}

async function runGraph(behold, argv) {
  let err = "";
  const code = await behold.runGraph(argv, { version: behold.version, prog: "behold graph", stdout: () => {}, stderr: (t) => (err += t) });
  if (code !== 0) throw new ReadFailed(`behold graph exited ${code}: ${err.trim() || "no message"}`);
}

/**
 * Phase one. Writes `<out>/changed.json`, `changed.svg` (when there are cards
 * to draw), `comment.md`, `pr.json` and `result.json`. Throws ReadFailed
 * after writing the failure to the job summary, unless fail-on-error is off.
 */
export async function readChanged({ env, inputs, behold, log = console }) {
  const pr = pullRequestOf(env);
  const base = inputs.base || pr?.base;
  const head = inputs.head || pr?.head;
  if (!base || !head) throw new Error("no base and head: this is not a pull_request run, so give the base and head inputs");
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const dir = resolve(workspace, inputs.path);
  mkdirSync(inputs.out, { recursive: true });
  const jsonFile = join(inputs.out, "changed.json");
  const svgFile = join(inputs.out, "changed.svg");
  const cutArgs = ["--changed", `${base}..${head}`, ...(inputs.depth ? ["--depth", inputs.depth] : []), ...(inputs.budget ? ["--budget", inputs.budget] : [])];
  try {
    let root;
    try {
      root = behold.gitRoot(dir);
    } catch (err) {
      throw new ReadFailed(err.message);
    }
    for (const sha of [base, head]) {
      if (!ensureCommit(root, sha)) throw new ReadFailed(`commit ${sha} is not in this clone and could not be fetched; check out with fetch-depth: 0`);
    }
    await runGraph(behold, [dir, ...cutArgs, "--json", "-o", jsonFile]);
    const checked = behold.checkGraphDocument(JSON.parse(readFileSync(jsonFile, "utf8")));
    if (!checked.ok) throw new ReadFailed(checked.error);
    const doc = checked.document;
    const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : "";
    const footer = runUrl ? `\n<sub>behold, from the [workflow run](${runUrl}); the SVG and JSON are artifacts of that run.</sub>\n` : "";
    const body = commentBody(behold, doc, { marker: inputs.marker, footer });
    let svg = false;
    if (doc.nodes.length > 0) {
      // A cut is at most the node budget, so the painter's flat-card limit does not meet one in practice; if it does, that is a failed read.
      await runGraph(behold, [dir, ...cutArgs, "--svg", ...(inputs.theme ? ["--theme", inputs.theme] : []), "-o", svgFile]);
      svg = true;
    }
    writeFileSync(join(inputs.out, "comment.md"), body.text);
    writeFileSync(join(inputs.out, "pr.json"), JSON.stringify({ number: pr?.number ?? null, base, head, marker: inputs.marker }));
    const result = { ok: true, kind: body.kind, summary: body.summary, svg, json: true, fork: !!pr?.fork, number: pr?.number ?? null };
    writeFileSync(join(inputs.out, "result.json"), JSON.stringify(result));
    setOutputs(env, { "changed-count": body.summary.total, "neighbour-count": body.summary.neighbours, "svg-path": svg ? svgFile : "", "json-path": jsonFile, "comment-path": join(inputs.out, "comment.md"), "out-dir": inputs.out, fork: result.fork });
    return result;
  } catch (err) {
    if (!(err instanceof ReadFailed)) throw err;
    appendSummary(env, `## behold: what this pull request changes\n\nThe read failed.\n\n\`\`\`\n${err.message}\n\`\`\`\n`);
    writeFileSync(join(inputs.out, "result.json"), JSON.stringify({ ok: false, error: err.message }));
    setOutputs(env, { "out-dir": inputs.out, "changed-count": "", fork: !!pr?.fork });
    if (inputs.failOnError) throw err;
    log.warn?.(`behold: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** Phase two. Summary first (it needs no token), then the comment when this run may post one. */
export async function report({ env, inputs, gh = githubClient({ token: inputs.token, apiUrl: env.GITHUB_API_URL }), log = console }) {
  const resultFile = join(inputs.out, "result.json");
  if (!existsSync(resultFile)) throw new Error(`no ${resultFile}: the read step did not run`);
  const result = JSON.parse(readFileSync(resultFile, "utf8"));
  if (!result.ok) return { skipped: "read failed" };
  const text = readFileSync(join(inputs.out, "comment.md"), "utf8");
  const body = { text, kind: result.kind, summary: result.summary };
  const artifacts = [
    { label: "changed.svg", url: env.ARTIFACT_URL_SVG },
    { label: "changed.json", url: env.ARTIFACT_URL_JSON },
  ];
  const repo = env.GITHUB_REPOSITORY;
  const mode = inputs.comment; // true | false | auto
  let commentNote = "";
  let comment = { action: "skipped" };
  if (mode === "false") commentNote = "Comment skipped: the comment input is false.";
  else if (result.number == null) commentNote = "No comment: this run is not for a pull request.";
  else if (result.fork) comment = { action: "fork" };
  else {
    comment = result.kind === "empty" ? await updateIfPresent(gh, { repo, number: result.number, body: text, marker: inputs.marker }) : await upsertComment(gh, { repo, number: result.number, body: text, marker: inputs.marker });
    if (comment.action === "denied") {
      commentNote = `The token could not write a comment (HTTP ${comment.status}). Give the job pull-requests: write, or use the workflow_run recipe in the action's README.`;
      log.warn?.(`behold: ${commentNote}`);
    } else if (comment.action === "none") commentNote = "Nothing changed and there is no earlier comment, so none was posted.";
    else commentNote = `Comment ${comment.action}${comment.url ? `: ${comment.url}` : ""}.`;
  }
  appendSummary(env, jobSummary(body, { artifacts, fork: comment.action === "fork", commentNote }));
  setOutputs(env, { "comment-action": comment.action, "comment-url": comment.url ?? "" });
  return comment;
}

/**
 * The second workflow of the fork recipe. It runs from the default branch with
 * a write token, reads the comment the first workflow produced and posts it.
 * The handoff is data from an untrusted run, so it is checked: the pull
 * request number must be an integer, the pull request's head must be the
 * commit the first run built, and the body must carry the marker and fit.
 */
export async function postComment({ env, inputs, gh = githubClient({ token: inputs.token, apiUrl: env.GITHUB_API_URL }), readFile = (p) => readFileSync(p, "utf8") }) {
  const event = JSON.parse(readFile(env.GITHUB_EVENT_PATH));
  const run = event.workflow_run;
  if (!run) throw new Error("post-comment runs on a workflow_run event");
  const dir = inputs.handoffDir;
  if (!dir) throw new Error("give handoff-dir, the folder the artifact was downloaded to");
  const pr = JSON.parse(readFile(join(dir, "pr.json")));
  const text = readFile(join(dir, "comment.md"));
  const number = pr.number;
  if (!Number.isInteger(number) || number <= 0) throw new Error(`pr.json holds no usable pull request number (${JSON.stringify(number)})`);
  const repo = env.GITHUB_REPOSITORY;
  const { data: live } = await gh.request("GET", `/repos/${repo}/pulls/${number}`);
  if (live.head?.sha !== run.head_sha) throw new Error(`pull request ${number} is at ${String(live.head?.sha).slice(0, 10)}, not the ${String(run.head_sha).slice(0, 10)} the first run read; not posting a stale comment`);
  if (pr.head && pr.head !== run.head_sha) throw new Error("pr.json names a different head than the run that produced it");
  const marker = inputs.marker;
  if (!text.startsWith(`<!-- ${marker} -->\n`)) throw new Error("comment.md does not start with the marker; not posting it");
  const limit = COMMENT_CHARS;
  if (text.length >= limit) throw new Error(`comment.md is ${text.length} characters, over ${limit}`);
  const out = await upsertComment(gh, { repo, number, body: text, marker });
  setOutputs(env, { "comment-action": out.action, "comment-url": out.url ?? "" });
  return out;
}

export { findComment };
