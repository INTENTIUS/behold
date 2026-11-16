import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as behold from "../../src/graph-package.ts";
import { HCL_PARSER_PKG, resolvedVersion, TERRAFORM_LEXICON_PKG } from "../../src/terraform-member.ts";
// @ts-expect-error the action is plain ESM JavaScript, outside tsconfig
import { githubClient, upsertComment } from "../src/github.mjs";
// @ts-expect-error
import { commentBody, countLine, summarize } from "../src/compose.mjs";
// @ts-expect-error
import { postComment, readChanged, readInputs, report } from "../src/run.mjs";

// behold#1062: the action's logic. The git repository is a throwaway one read
// through the real Terraform reader; GitHub is a table of recorded responses
// (test/fixtures), so a call that no row names fails the test and nothing
// reaches the network.

const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const gate = !(resolvedVersion(TERRAFORM_LEXICON_PKG) && resolvedVersion(HCL_PARSER_PKG)) && !REQUIRE_PEERS;

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

// ---------------------------------------------------------------------------
// A recorded GitHub
// ---------------------------------------------------------------------------

interface Route {
  method: string;
  path: RegExp;
  status?: number;
  file: string;
  headers?: Record<string, string>;
  /** Replace __HEAD__ and __BASE__ in the fixture. */
  vars?: Record<string, string>;
}
interface Call {
  method: string;
  url: string;
  body?: string;
}

function recorded(routes: Route[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, ...(init?.body ? { body: String(init.body) } : {}) });
    const route = routes.find((r) => r.method === method && r.path.test(new URL(url).pathname + new URL(url).search));
    if (!route) throw new Error(`no recorded response for ${method} ${url}`);
    let text = fixture(route.file);
    for (const [k, v] of Object.entries(route.vars ?? {})) text = text.replaceAll(`__${k}__`, v);
    return new Response(text, { status: route.status ?? 200, headers: { "content-type": "application/json", ...route.headers } });
  };
  return { fetch: f as typeof fetch, calls };
}

const PAGE2 = "https://api.github.com/repositories/1/issues/7/comments?per_page=100&page=2";
const comments = (...files: string[]): Route[] =>
  files.length === 2
    ? [
        { method: "GET", path: /\/issues\/7\/comments\?per_page=100$/, file: files[0]!, headers: { link: `<${PAGE2}>; rel="next"` } },
        { method: "GET", path: /\/issues\/7\/comments\?per_page=100&page=2$/, file: files[1]! },
      ]
    : [{ method: "GET", path: /\/issues\/7\/comments\?per_page=100$/, file: files[0]! }];
const created: Route = { method: "POST", path: /\/issues\/7\/comments$/, status: 201, file: "comment-created.json" };
const updated: Route = { method: "PATCH", path: /\/issues\/comments\/1102$/, file: "comment-updated.json" };

// ---------------------------------------------------------------------------
// A repository, and the environment a run sees
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

const HEADER = 'provider "aws" {\n  region = "us-east-1"\n}\n\n';
const FIRST = `${HEADER}resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}

resource "aws_kms_key" "logs" {
  description = "logs"
}

resource "aws_s3_bucket" "logs" {
  bucket = "logs"
  kms    = aws_kms_key.logs.arn
}
`;
// Adds aws_security_group.web, changes aws_subnet.a, removes aws_s3_bucket.logs.
const SECOND = FIRST.replace('"10.0.1.0/24"', '"10.0.2.0/24"')
  .replace(/resource "aws_s3_bucket" "logs" \{[^}]*\}\n/, "")
  .concat('\nresource "aws_security_group" "web" {\n  vpc_id = aws_vpc.main.id\n}\n');

function repo(commits: string[]): { dir: string; base: string; head: string } {
  const dir = join(scratch("behold-1062-"), "estate");
  mkdirSync(join(dir, "net"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const text of commits) {
    writeFileSync(join(dir, "net", "main.tf"), text);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "c");
  }
  return { dir, base: git(dir, "rev-parse", "HEAD~1"), head: git(dir, "rev-parse", "HEAD") };
}

interface Run {
  env: Record<string, string>;
  inputs: ReturnType<typeof readInputs>;
  summary: () => string;
  outputs: () => string;
  out: string;
}

function run(r: { dir: string; base: string; head: string }, event: string, extra: Record<string, string> = {}): Run {
  const tmp = scratch("behold-1062-run-");
  const eventPath = join(tmp, "event.json");
  writeFileSync(eventPath, fixture(event).replaceAll("__HEAD__", r.head).replaceAll("__BASE__", r.base));
  const env: Record<string, string> = {
    GITHUB_WORKSPACE: r.dir,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "acme/infra",
    GITHUB_RUN_ID: "9001",
    GITHUB_STEP_SUMMARY: join(tmp, "summary.md"),
    GITHUB_OUTPUT: join(tmp, "output.txt"),
    RUNNER_TEMP: tmp,
    INPUT_GITHUB_TOKEN: "test-token",
    INPUT_OUTPUT_DIR: join(tmp, "out"),
    ...extra,
  };
  const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return { env, inputs: readInputs(env), summary: () => read(env.GITHUB_STEP_SUMMARY!), outputs: () => read(env.GITHUB_OUTPUT!), out: env.INPUT_OUTPUT_DIR! };
}

const behold1 = { ...behold, version: "0.0.0-test" };
const quiet = { warn: () => {}, log: () => {}, error: () => {} };

// ---------------------------------------------------------------------------

describe("the action, read phase (#1062)", () => {
  it.skipIf(gate)("writes the JSON, the SVG and a comment body for a pull request that changes resources", { timeout: 240_000 }, async () => {
    const r = repo([FIRST, SECOND]);
    const x = run(r, "event-pull-request.json");
    const result = await readChanged({ env: x.env, inputs: x.inputs, behold: behold1, log: quiet });
    expect(result).toMatchObject({ ok: true, kind: "diagram", svg: true, fork: false, number: 7 });

    const doc = JSON.parse(readFileSync(join(x.out, "changed.json"), "utf8"));
    expect(doc.nodes.filter((n: { diff: string }) => n.diff !== "neighbour").map((n: { id: string; diff: string }) => [n.id.split("/").pop(), n.diff]).sort()).toEqual([
      ["aws_s3_bucket.logs", "removed"],
      ["aws_security_group.web", "added"],
      ["aws_subnet.a", "changed"],
    ]);
    expect(doc.cut).toMatchObject({ kind: "changed", base: r.base, head: r.head, counts: { added: 1, removed: 1, changed: 1 } });
    expect(readFileSync(join(x.out, "changed.svg"), "utf8")).toMatch(/^<svg|^<\?xml/);

    const body = readFileSync(join(x.out, "comment.md"), "utf8");
    expect(body.startsWith("<!-- behold:changed -->\n")).toBe(true);
    expect(body).toContain("**behold:** 1 changed, 1 added, 1 removed, 2 neighbours, in 1 root");
    expect(body).toContain("```mermaid");
    expect(body).not.toContain(tmpdir());
    expect(body.length).toBeLessThan(262_144);
    expect(JSON.parse(readFileSync(join(x.out, "pr.json"), "utf8"))).toEqual({ number: 7, base: r.base, head: r.head, marker: "behold:changed" });
    expect(x.outputs()).toContain("changed-count=3");
    // The checkout is only read.
    expect(git(r.dir, "status", "--porcelain")).toBe("");
  });

  it.skipIf(gate)("falls back to a per-root table when the cut is over the budget", { timeout: 240_000 }, async () => {
    const r = repo([FIRST, SECOND]);
    const x = run(r, "event-pull-request.json", { INPUT_BUDGET: "2" });
    const result = await readChanged({ env: x.env, inputs: x.inputs, behold: behold1, log: quiet });
    expect(result.kind).toBe("table");
    const body = readFileSync(join(x.out, "comment.md"), "utf8");
    expect(body).not.toContain("```mermaid");
    expect(body).toContain("| Changed, by box |");
    expect(result.svg).toBe(false);
  });

  it.skipIf(gate)("says so when nothing changed", { timeout: 240_000 }, async () => {
    const r = repo([FIRST, `${FIRST}\n\n`]);
    const x = run(r, "event-pull-request.json");
    const result = await readChanged({ env: x.env, inputs: x.inputs, behold: behold1, log: quiet });
    expect(result).toMatchObject({ kind: "empty", svg: false });
    expect(readFileSync(join(x.out, "comment.md"), "utf8")).toContain("Nothing changed");
  });

  it.skipIf(gate)("is a failed read when the base commit is not in the clone, after writing the summary", { timeout: 240_000 }, async () => {
    const r = repo([FIRST, SECOND]);
    const x = run(r, "event-pull-request.json", { INPUT_BASE: "0".repeat(40) });
    await expect(readChanged({ env: x.env, inputs: x.inputs, behold: behold1, log: quiet })).rejects.toThrow(/not in this clone/);
    expect(x.summary()).toContain("The read failed.");
    // fail-on-error: false reports it and goes on, with nothing to post.
    const y = run(r, "event-pull-request.json", { INPUT_BASE: "0".repeat(40), INPUT_FAIL_ON_ERROR: "false" });
    expect(await readChanged({ env: y.env, inputs: y.inputs, behold: behold1, log: quiet })).toMatchObject({ ok: false });
    const { fetch: f, calls } = recorded([]);
    const out = await report({ env: y.env, inputs: y.inputs, gh: githubClient({ token: "t", fetch: f }), log: quiet });
    expect(out).toEqual({ skipped: "read failed" });
    expect(calls).toEqual([]);
  });

  it("treats an SVG painter refusal as a failed read", async () => {
    const tmp = scratch("behold-1062-svg-");
    const doc = { schema: "behold-graph/1", generator: { behold: "t" }, origin: { dir: "." }, cut: { kind: "changed", counts: { added: 1, removed: 0, changed: 0 } }, nodes: [{ id: "n", title: "n", subtitle: "terraform", kind: "k", lexicon: "terraform", diff: "added", attrs: {} }], edges: [], groups: [], notes: [] };
    const fake = {
      ...behold,
      version: "t",
      gitRoot: () => tmp,
      checkGraphDocument: behold.checkGraphDocument,
      runGraph: async (argv: string[], io: { stderr: (t: string) => void }) => {
        if (argv.includes("--svg")) {
          io.stderr("behold graph: FlatLayoutTooLarge: 401 flat cards\n");
          return 1;
        }
        writeFileSync(argv[argv.indexOf("-o") + 1]!, JSON.stringify(doc));
        return 0;
      },
    };
    git(tmp, "init", "-q", "-b", "main");
    writeFileSync(join(tmp, "a"), "x");
    git(tmp, "add", "-A");
    git(tmp, "commit", "-q", "-m", "c");
    const sha = git(tmp, "rev-parse", "HEAD");
    const x = run({ dir: tmp, base: sha, head: sha }, "event-pull-request.json");
    await expect(readChanged({ env: x.env, inputs: x.inputs, behold: fake, log: quiet })).rejects.toThrow(/exited 1: .*FlatLayoutTooLarge/);
    expect(x.summary()).toContain("FlatLayoutTooLarge");
  });
});

describe("the action, report phase (#1062)", () => {
  async function readFirst(event = "event-pull-request.json", extra: Record<string, string> = {}) {
    const r = repo([FIRST, SECOND]);
    const x = run(r, event, { ARTIFACT_URL_SVG: "https://github.com/acme/infra/actions/runs/9001/artifacts/1", ARTIFACT_URL_JSON: "https://github.com/acme/infra/actions/runs/9001/artifacts/2", ...extra });
    await readChanged({ env: x.env, inputs: x.inputs, behold: behold1, log: quiet });
    return { r, x };
  }

  it.skipIf(gate)("creates the comment on the first push and writes the summary with the artifact links", { timeout: 240_000 }, async () => {
    const { x } = await readFirst();
    const gh = recorded([...comments("comments-empty.json"), created]);
    const out = await report({ env: x.env, inputs: x.inputs, gh: githubClient({ token: "t", fetch: gh.fetch }), log: quiet });
    expect(out.action).toBe("created");
    expect(gh.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    const posted = JSON.parse(gh.calls[1]!.body!).body as string;
    expect(posted).toBe(readFileSync(join(x.out, "comment.md"), "utf8"));
    const summary = x.summary();
    expect(summary).toContain("## behold: what this pull request changes");
    expect(summary).toContain("```mermaid");
    expect(summary).not.toContain("<!-- behold:changed -->");
    expect(summary).toContain("[changed.svg](https://github.com/acme/infra/actions/runs/9001/artifacts/1)");
    expect(summary).toContain("[changed.json](https://github.com/acme/infra/actions/runs/9001/artifacts/2)");
    expect(Buffer.byteLength(summary)).toBeLessThan(1024 * 1024);
  });

  it.skipIf(gate)("edits the one comment on a second push, found on the second page of comments", { timeout: 240_000 }, async () => {
    const { x } = await readFirst();
    const gh = recorded([...comments("comments-page1.json", "comments-page2.json"), updated, created]);
    const out = await report({ env: x.env, inputs: x.inputs, gh: githubClient({ token: "t", fetch: gh.fetch }), log: quiet });
    expect(out).toMatchObject({ action: "updated" });
    expect(gh.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /repos/acme/infra/issues/7/comments", "GET /repositories/1/issues/7/comments", "PATCH /repos/acme/infra/issues/comments/1102"]);
    expect(gh.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it.skipIf(gate)("leaves an unchanged comment alone", { timeout: 240_000 }, async () => {
    const { x } = await readFirst();
    const body = readFileSync(join(x.out, "comment.md"), "utf8");
    const same = JSON.parse(fixture("comments-page2.json"));
    same[0].body = body;
    const tmp = scratch("behold-1062-same-");
    writeFileSync(join(tmp, "x.json"), JSON.stringify(same));
    const gh = githubClient({
      token: "t",
      fetch: (async (_u: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") !== "GET") throw new Error("wrote");
        return new Response(readFileSync(join(tmp, "x.json"), "utf8"));
      }) as typeof fetch,
    });
    expect((await upsertComment(gh, { repo: "acme/infra", number: 7, body, marker: "behold:changed" })).action).toBe("unchanged");
  });

  it.skipIf(gate)("on a fork's pull_request run makes no API call and leaves the comment to the second workflow", { timeout: 240_000 }, async () => {
    const { x } = await readFirst("event-pull-request-fork.json");
    const gh = recorded([]);
    const out = await report({ env: x.env, inputs: x.inputs, gh: githubClient({ token: "t", fetch: gh.fetch }), log: quiet });
    expect(out.action).toBe("fork");
    expect(gh.calls).toEqual([]);
    expect(x.summary()).toContain("This run is from a fork");
    expect(x.summary()).toContain("```mermaid");
    expect(existsSync(join(x.out, "comment.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(x.out, "result.json"), "utf8")).fork).toBe(true);
  });

  it.skipIf(gate)("is not a failure when the token may not comment", { timeout: 240_000 }, async () => {
    const { x } = await readFirst();
    const gh = recorded([...comments("comments-empty.json"), { ...created, status: 403, file: "forbidden.json" }]);
    const out = await report({ env: x.env, inputs: x.inputs, gh: githubClient({ token: "t", fetch: gh.fetch }), log: quiet });
    expect(out).toEqual({ action: "denied", status: 403 });
    expect(x.summary()).toContain("pull-requests: write");
  });

  it.skipIf(gate)("comment: false writes the summary and calls nothing", { timeout: 240_000 }, async () => {
    const { x } = await readFirst("event-pull-request.json", { INPUT_COMMENT: "false" });
    const gh = recorded([]);
    await report({ env: x.env, inputs: readInputs(x.env), gh: githubClient({ token: "t", fetch: gh.fetch }), log: quiet });
    expect(gh.calls).toEqual([]);
    expect(x.summary()).toContain("```mermaid");
  });
});

describe("the second workflow, post-comment (#1062)", () => {
  const MARKER = "behold:changed";
  function handoff(over: { number?: unknown; text?: string; head?: string } = {}) {
    const r = { dir: "", base: "b".repeat(40), head: "a".repeat(40) };
    const x = run({ ...r, dir: scratch("behold-1062-w-") }, "event-workflow-run.json", { INPUT_MARKER: MARKER });
    const dir = scratch("behold-1062-handoff-");
    writeFileSync(join(dir, "pr.json"), JSON.stringify({ number: "number" in over ? over.number : 7, base: r.base, head: over.head ?? r.head, marker: MARKER }));
    writeFileSync(join(dir, "comment.md"), over.text ?? `<!-- ${MARKER} -->\n**behold:** 1 changed, in 1 root\n`);
    x.env.INPUT_HANDOFF_DIR = dir;
    return { x, inputs: readInputs(x.env), r };
  }
  const pull = (head: string): Route => ({ method: "GET", path: /\/pulls\/7$/, file: "pull-live.json", vars: { HEAD: head, BASE: "b".repeat(40) } });

  it("posts the comment a fork's run produced, after checking the pull request is still at that head", async () => {
    const { x, inputs, r } = handoff();
    const gh = recorded([pull(r.head), ...comments("comments-empty.json"), created]);
    const out = await postComment({ env: x.env, inputs, gh: githubClient({ token: "t", fetch: gh.fetch }) });
    expect(out.action).toBe("created");
    expect(gh.calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
  });

  it("edits the existing comment when the first run's comment is already there", async () => {
    const { x, inputs, r } = handoff();
    const gh = recorded([pull(r.head), ...comments("comments-page1.json", "comments-page2.json"), updated]);
    expect((await postComment({ env: x.env, inputs, gh: githubClient({ token: "t", fetch: gh.fetch }) })).action).toBe("updated");
  });

  it("refuses a stale head, a bad number, a body without the marker and an oversize body", async () => {
    const stale = handoff();
    await expect(postComment({ env: stale.x.env, inputs: stale.inputs, gh: githubClient({ token: "t", fetch: recorded([pull("c".repeat(40))]).fetch }) })).rejects.toThrow(/stale/);
    for (const [over, re] of [
      [{ number: "7; rm" }, /usable pull request number/],
      [{ number: -1 }, /usable pull request number/],
      [{ text: "hello\n" }, /marker/],
      [{ text: `<!-- ${MARKER} -->\n${"x".repeat(262_144)}` }, /over 262144/],
    ] as const) {
      const h = handoff(over);
      await expect(postComment({ env: h.x.env, inputs: h.inputs, gh: githubClient({ token: "t", fetch: recorded([pull(h.r.head)]).fetch }) })).rejects.toThrow(re);
    }
  });
});

describe("the comment body (#1062)", () => {
  const nodes = Array.from({ length: 9000 }, (_, i) => ({ id: `r${i}`, title: `t${i}`, subtitle: "terraform", kind: "aws_thing", lexicon: "terraform", box: `stack:${i % 3}`, diff: i < 5 ? "changed" : "neighbour", attrs: {} }));
  const doc = {
    schema: "behold-graph/1",
    generator: { behold: "t" },
    origin: { dir: "." },
    cut: { kind: "changed", base: "A", head: "B", counts: { added: 0, removed: 0, changed: 5 } },
    nodes,
    edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i]!.id, target: n.id, kind: "ref", inferred: false })),
    groups: [0, 1, 2].map((i) => ({ id: `stack:${i}`, title: `root-${i}`, kind: "stack" })),
    notes: [],
  };

  it("counts changed cards, neighbours and roots", () => {
    const s = summarize(doc);
    expect(countLine(s)).toBe("5 changed, 8995 neighbours, in 3 roots");
  });

  it("is a table that fits the comment limit when the diagram does not", () => {
    const b = commentBody(behold, doc, { marker: "m" });
    expect(b.kind).toBe("table");
    expect(b.text.length).toBeLessThan(262_144);
    expect(b.text).toContain("| Root |");
  });
});

describe("the action folder (#1062)", () => {
  it("has an action.yml that pins its steps and names the artifact uploads", () => {
    const yml = readFileSync(join(import.meta.dirname, "..", "..", "action.yml"), "utf8");
    expect(yml).toMatch(/using: composite/);
    expect([...yml.matchAll(/uses: (\S+)/g)].every((m) => /@[0-9a-f]{40}$/.test(m[1]!))).toBe(true);
    expect(yml).toContain("archive: false");
  });
});
