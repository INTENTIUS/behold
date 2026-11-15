import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as behold from "../../src/graph-package.ts";
import { HCL_PARSER_PKG, resolvedVersion, TERRAFORM_LEXICON_PKG } from "../../src/terraform-member.ts";
// @ts-expect-error the action is plain ESM JavaScript, outside tsconfig
import { forgejoClient, upsertComment as forgejoUpsert } from "../src/forgejo.mjs";
// @ts-expect-error
import { detectForge } from "../src/forge.mjs";
// @ts-expect-error
import { gitlabClient, mergeRequestOf, upsertNote } from "../src/gitlab.mjs";
// @ts-expect-error
import { commentBody } from "../src/compose.mjs";
// @ts-expect-error
import { postComment, readChanged, readInputs, report } from "../src/run.mjs";

// behold#1064: the GitLab merge request note and the Forgejo comment. As in
// action.test.ts, the repository is a throwaway one read through the real
// Terraform reader and each forge is a table of recorded responses shaped
// after its REST documentation (test/fixtures), so a call that no row names
// fails the test and nothing reaches a real merge request or pull request.

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

interface Route {
  method: string;
  path: RegExp;
  status?: number;
  file: string;
  headers?: Record<string, string>;
}
interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function recorded(routes: Route[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, ...(init?.body ? { body: String(init.body) } : {}) });
    const u = new URL(url);
    const route = routes.find((r) => r.method === method && r.path.test(u.pathname + u.search));
    if (!route) throw new Error(`no recorded response for ${method} ${url}`);
    return new Response(fixture(route.file), { status: route.status ?? 200, headers: { "content-type": "application/json", ...route.headers } });
  };
  return { fetch: f as typeof fetch, calls };
}

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

resource "aws_security_group" "web" {
  vpc_id = aws_vpc.main.id
}
`;
// Changes aws_subnet.a and aws_security_group.web: two resources.
const SECOND = FIRST.replace('"10.0.1.0/24"', '"10.0.2.0/24"').replace("vpc_id = aws_vpc.main.id", 'vpc_id = aws_vpc.main.id\n  name   = "web"');

// Many subnets, all changed: a cut whose diagram cannot fit in 2,000 characters.
const MANY = 55;
const wide = (cidr: string): string => HEADER + Array.from({ length: MANY }, (_, i) => `resource "aws_subnet" "s${i}" {\n  vpc_id     = "v"\n  cidr_block = "${cidr}.${i}.0/24"\n}\n`).join("\n");

function repo(commits: string[]): { dir: string; base: string; head: string } {
  const dir = join(scratch("behold-1064-"), "estate");
  mkdirSync(join(dir, "net"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const text of commits) {
    writeFileSync(join(dir, "net", "main.tf"), text);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "c");
  }
  return { dir, base: git(dir, "rev-parse", "HEAD~1"), head: git(dir, "rev-parse", "HEAD") };
}

const behold1 = { ...behold, version: "0.0.0-test" };
const quiet = { warn: () => {}, log: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

const GL_API = "https://gitlab.example.com/api/v4";
const GL_MR = "https://gitlab.example.com/acme/infra/-/merge_requests/7";
const glNotes = "/projects/4242/merge_requests/7/notes";
const glList = (...files: string[]): Route[] =>
  files.length === 2
    ? [
        { method: "GET", path: /\/notes\?sort=asc&order_by=created_at&per_page=100$/, file: files[0]!, headers: { link: `<${GL_API}/projects/4242/merge_requests/7/notes?sort=asc&order_by=created_at&per_page=100&page=2>; rel="next"`, "x-next-page": "2" } },
        { method: "GET", path: /\/notes\?sort=asc&order_by=created_at&per_page=100&page=2$/, file: files[1]! },
      ]
    : [{ method: "GET", path: /\/notes\?sort=asc&order_by=created_at&per_page=100$/, file: files[0]! }];
const glCreate: Route = { method: "POST", path: /\/merge_requests\/7\/notes$/, status: 201, file: "gitlab-note-created.json" };
const glEdit: Route = { method: "PUT", path: /\/merge_requests\/7\/notes\/3303$/, file: "gitlab-note-updated.json" };

/** What a merge request pipeline sets. */
function glEnv(r: { dir: string; base: string; head: string }, extra: Record<string, string> = {}): Record<string, string> {
  const tmp = scratch("behold-1064-gl-");
  return {
    GITLAB_CI: "true",
    CI_PROJECT_DIR: r.dir,
    CI_PROJECT_ID: "4242",
    CI_API_V4_URL: GL_API,
    CI_JOB_URL: "https://gitlab.example.com/acme/infra/-/jobs/9001",
    CI_MERGE_REQUEST_IID: "7",
    CI_MERGE_REQUEST_PROJECT_ID: "4242",
    CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "4242",
    CI_MERGE_REQUEST_PROJECT_URL: "https://gitlab.example.com/acme/infra",
    CI_MERGE_REQUEST_DIFF_BASE_SHA: r.base,
    CI_COMMIT_SHA: r.head,
    RUNNER_TEMP: tmp,
    INPUT_FORGE: "gitlab",
    BEHOLD_GITLAB_TOKEN: "glpat-test",
    INPUT_OUTPUT_DIR: join(r.dir, "behold-changed"),
    ...extra,
  };
}

describe("GitLab: the merge request (#1064)", () => {
  it("reads the number, the commits and the project from CI variables", () => {
    const env = glEnv({ dir: "/w", base: "b".repeat(40), head: "a".repeat(40) });
    expect(mergeRequestOf(env)).toMatchObject({ number: 7, base: "b".repeat(40), head: "a".repeat(40), fork: false, project: "4242", webUrl: GL_MR });
  });

  it("prefers the source branch sha of a merged results pipeline, where CI_COMMIT_SHA is the merge commit", () => {
    const env = { ...glEnv({ dir: "/w", base: "b".repeat(40), head: "m".repeat(40) }), CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: "a".repeat(40) };
    expect(mergeRequestOf(env)?.head).toBe("a".repeat(40));
  });

  it("calls a merge request from another project a fork", () => {
    expect(mergeRequestOf({ ...glEnv({ dir: "/w", base: "b", head: "a" }), CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "9999" })?.fork).toBe(true);
  });

  it("is not a merge request on a branch pipeline", () => {
    expect(mergeRequestOf({ GITLAB_CI: "true", CI_PROJECT_ID: "4242", CI_COMMIT_SHA: "a" })).toBeUndefined();
  });

  it("is picked by GITLAB_CI, and by the input when given", () => {
    expect(detectForge({ GITLAB_CI: "true" })).toBe("gitlab");
    expect(detectForge({ GITLAB_CI: "true", GITHUB_ACTIONS: "true" }, "github")).toBe("github");
    expect(() => detectForge({}, "bitbucket")).toThrow(/unknown forge/);
  });
});

describe("GitLab: the one note (#1064)", () => {
  const args = { project: 4242, iid: 7, body: "<!-- behold:changed -->\nbody", marker: "behold:changed", webUrl: GL_MR };

  it("creates the note on the first push, with the token in PRIVATE-TOKEN", async () => {
    const gl = recorded([...glList("gitlab-notes-empty.json"), glCreate]);
    const out = await upsertNote(gitlabClient({ token: "glpat-test", apiUrl: GL_API, fetch: gl.fetch }), args);
    expect(out).toEqual({ action: "created", url: `${GL_MR}#note_3304` });
    expect(gl.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(JSON.parse(gl.calls[1]!.body!)).toEqual({ body: args.body });
    expect(gl.calls[0]!.headers["private-token"]).toBe("glpat-test");
    expect(gl.calls[0]!.headers.authorization).toBeUndefined();
  });

  it("edits the one note on a second push, found on the second page and past a system note", async () => {
    const gl = recorded([...glList("gitlab-notes-page1.json", "gitlab-notes-page2.json"), glEdit, glCreate]);
    const out = await upsertNote(gitlabClient({ token: "t", apiUrl: GL_API, fetch: gl.fetch }), args);
    expect(out).toEqual({ action: "updated", url: `${GL_MR}#note_3303` });
    expect(gl.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([`GET /api/v4${glNotes}`, `GET /api/v4${glNotes}`, `PUT /api/v4${glNotes}/3303`]);
  });

  it("does not take a system note that quotes the marker for the behold note", async () => {
    const gl = gitlabClient({
      token: "t",
      apiUrl: GL_API,
      fetch: (async (_u: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify([{ id: 1, system: true, body: "<!-- behold:changed -->" }]));
        return new Response(fixture("gitlab-note-created.json"), { status: 201 });
      }) as typeof fetch,
    });
    expect((await upsertNote(gl, args)).action).toBe("created");
  });

  it("leaves an unchanged note alone", async () => {
    const same = JSON.parse(fixture("gitlab-notes-page2.json"));
    same[1].body = args.body;
    const gl = gitlabClient({
      token: "t",
      apiUrl: GL_API,
      fetch: (async (_u: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") !== "GET") throw new Error("wrote");
        return new Response(JSON.stringify(same));
      }) as typeof fetch,
    });
    expect((await upsertNote(gl, args)).action).toBe("unchanged");
  });

  it("answers denied, not a throw, for 403 and 401", async () => {
    for (const [status, file] of [[403, "gitlab-forbidden.json"], [401, "gitlab-unauthorized.json"]] as const) {
      const gl = recorded([...glList("gitlab-notes-empty.json"), { ...glCreate, status, file }]);
      expect(await upsertNote(gitlabClient({ token: "t", apiUrl: GL_API, fetch: gl.fetch }), args)).toEqual({ action: "denied", status });
    }
  });
});

describe("GitLab: the comment body (#1064)", () => {
  const mk = (n: number) => {
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `r${i}`, title: `aws_subnet.long_resource_name_${i}`, subtitle: "terraform", kind: "aws_subnet", lexicon: "terraform", box: `stack:${i % 2}`, diff: "changed", attrs: {} }));
    return {
      schema: "behold-graph/1",
      generator: { behold: "t" },
      origin: { dir: "." },
      cut: { kind: "changed", base: "A", head: "B", counts: { added: 0, removed: 0, changed: n } },
      nodes,
      edges: nodes.slice(1).map((x, i) => ({ id: `e${i}`, source: nodes[i]!.id, target: x.id, kind: "ref", inferred: false })),
      groups: [0, 1].map((i) => ({ id: `stack:${i}`, title: `root-${i}`, kind: "stack" })),
      notes: [],
    };
  };
  const fences = (t: string): string[] => [...t.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]!);

  it("keeps a small cut as one Mermaid block under GitLab's 2,000 characters", () => {
    const b = commentBody(behold, mk(3), { marker: "m", forge: "gitlab" });
    expect(b.kind).toBe("diagram");
    expect(fences(b.text)).toHaveLength(1);
    expect(fences(b.text)[0]!.length).toBeLessThan(2000);
  });

  it("falls to the table, with no block left as text, when the cut does not fit", () => {
    const b = commentBody(behold, mk(40), { marker: "m", forge: "gitlab", footer: "\n<sub>[changed.svg](https://x/changed.svg)</sub>\n" });
    expect(b.kind).toBe("table");
    expect(b.text).not.toContain("```mermaid");
    expect(b.text).toContain("| Root |");
    expect(b.text).toContain("[changed.svg](https://x/changed.svg)");
    // The same cut is a diagram on GitHub, whose block budget is ten times larger.
    expect(commentBody(behold, mk(40), { marker: "m", forge: "github" }).kind).toBe("diagram");
  });
});

describe("GitLab: the job (#1064)", () => {
  async function readFirst(commits: string[], extra: Record<string, string> = {}) {
    const r = repo(commits);
    const env = glEnv(r, extra);
    const inputs = readInputs(env);
    await readChanged({ env, inputs, behold: behold1, log: quiet });
    return { r, env, inputs, out: inputs.out as string };
  }
  const logged = () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((t: string) => (chunks.push(String(t)), true)) as typeof process.stdout.write);
    return { text: () => chunks.join(""), done: () => spy.mockRestore() };
  };

  it.skipIf(gate)("a merge request that changes two resources gets one note with a block that fits, and the second push edits it", { timeout: 240_000 }, async () => {
    const out = logged();
    try {
      const { env, inputs, out: dir } = await readFirst([FIRST, SECOND]);
      const body = readFileSync(join(dir, "comment.md"), "utf8");
      expect(body.startsWith("<!-- behold:changed -->\n")).toBe(true);
      expect(body).toContain("**behold:** 2 changed");
      expect(body).toContain("https://gitlab.example.com/acme/infra/-/jobs/9001/artifacts/file/behold-changed/changed.svg");
      const blocks = [...body.matchAll(/```mermaid\n([\s\S]*?)```/g)];
      expect(blocks).toHaveLength(1);
      expect(blocks[0]![1]!.length).toBeLessThan(2000);

      const first = recorded([...glList("gitlab-notes-empty.json"), glCreate]);
      expect((await report({ env, inputs, gh: gitlabClient({ token: "t", apiUrl: GL_API, fetch: first.fetch }), log: quiet })).action).toBe("created");
      expect(JSON.parse(first.calls[1]!.body!).body).toBe(body);

      const second = recorded([...glList("gitlab-notes-page1.json", "gitlab-notes-page2.json"), glEdit, glCreate]);
      const edited = await report({ env, inputs, gh: gitlabClient({ token: "t", apiUrl: GL_API, fetch: second.fetch }), log: quiet });
      expect(edited).toMatchObject({ action: "updated", url: `${GL_MR}#note_3303` });
      expect(second.calls.some((c) => c.method === "POST")).toBe(false);
      // The job log carries what a job summary would.
      expect(out.text()).toContain("## behold: what this merge request changes");
    } finally {
      out.done();
    }
  });

  it.skipIf(gate)("a cut over 2,000 characters gets the table and the SVG link and no Mermaid block", { timeout: 240_000 }, async () => {
    const out = logged();
    try {
      const { env, inputs, out: dir } = await readFirst([wide("10.0"), wide("10.1")]);
      const body = readFileSync(join(dir, "comment.md"), "utf8");
      expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).kind).toBe("table");
      expect(body).not.toContain("```mermaid");
      expect(body).toContain("| Root |");
      expect(body).toContain("/artifacts/file/behold-changed/changed.svg");
      expect(existsSync(join(dir, "changed.svg"))).toBe(true);
      const gl = recorded([...glList("gitlab-notes-empty.json"), glCreate]);
      expect((await report({ env, inputs, gh: gitlabClient({ token: "t", apiUrl: GL_API, fetch: gl.fetch }), log: quiet })).action).toBe("created");
      expect(JSON.parse(gl.calls[1]!.body!).body).not.toContain("```mermaid");
    } finally {
      out.done();
    }
  });

  it.skipIf(gate)("a merge request from a fork makes no API call and says so in the log", { timeout: 240_000 }, async () => {
    const out = logged();
    try {
      const { env, inputs } = await readFirst([FIRST, SECOND], { CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "9999" });
      const gl = recorded([]);
      expect((await report({ env, inputs, gh: gitlabClient({ token: "t", apiUrl: GL_API, fetch: gl.fetch }), log: quiet })).action).toBe("fork");
      expect(gl.calls).toEqual([]);
      expect(out.text()).toContain("This merge request is from a fork");
    } finally {
      out.done();
    }
  });

  it.skipIf(gate)("is not a failure when the token may not write a note", { timeout: 240_000 }, async () => {
    const out = logged();
    try {
      const { env, inputs } = await readFirst([FIRST, SECOND]);
      const gl = recorded([...glList("gitlab-notes-empty.json"), { ...glCreate, status: 403, file: "gitlab-forbidden.json" }]);
      expect(await report({ env, inputs, gh: gitlabClient({ token: "t", apiUrl: GL_API, fetch: gl.fetch }), log: quiet })).toEqual({ action: "denied", status: 403 });
      expect(out.text()).toContain("api scope");
    } finally {
      out.done();
    }
  });

  it("refuses post-comment, which is GitHub's workflow_run recipe", async () => {
    const env = glEnv({ dir: "/w", base: "b", head: "a" });
    await expect(postComment({ env, inputs: readInputs(env), gh: gitlabClient({ fetch: recorded([]).fetch }) })).rejects.toThrow(/only GitHub has/);
  });
});

// ---------------------------------------------------------------------------
// Forgejo
// ---------------------------------------------------------------------------

const FJ_API = "https://forgejo.example.com/api/v1";
const fjList = (...files: string[]): Route[] =>
  files.length === 2
    ? [
        // No Link header: the client goes on by page number until X-Total-Count is reached.
        { method: "GET", path: /\/issues\/7\/comments\?limit=50&page=1$/, file: files[0]!, headers: { "x-total-count": "52" } },
        { method: "GET", path: /\/issues\/7\/comments\?limit=50&page=2$/, file: files[1]!, headers: { "x-total-count": "52" } },
      ]
    : [{ method: "GET", path: /\/issues\/7\/comments\?limit=50&page=1$/, file: files[0]!, headers: { "x-total-count": "0" } }];
const fjCreate: Route = { method: "POST", path: /\/issues\/7\/comments$/, status: 201, file: "forgejo-comment-created.json" };
const fjEdit: Route = { method: "PATCH", path: /\/issues\/comments\/2151$/, file: "forgejo-comment-updated.json" };

function fjEnv(r: { dir: string; base: string; head: string }, event: string, extra: Record<string, string> = {}): Record<string, string> {
  const tmp = scratch("behold-1064-fj-");
  const eventPath = join(tmp, "event.json");
  writeFileSync(eventPath, fixture(event).replaceAll("__HEAD__", r.head).replaceAll("__BASE__", r.base));
  return {
    FORGEJO_ACTIONS: "true",
    GITHUB_WORKSPACE: r.dir,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "acme/infra",
    FORGEJO_REPOSITORY: "acme/infra",
    FORGEJO_SERVER_URL: "https://forgejo.example.com",
    FORGEJO_API_URL: FJ_API,
    FORGEJO_RUN_NUMBER: "12",
    GITHUB_RUN_ID: "9001",
    GITHUB_STEP_SUMMARY: join(tmp, "summary.md"),
    GITHUB_OUTPUT: join(tmp, "output.txt"),
    RUNNER_TEMP: tmp,
    INPUT_GITHUB_TOKEN: "test-token",
    INPUT_OUTPUT_DIR: join(tmp, "out"),
    ...extra,
  };
}
const fjClient = (f: typeof fetch) => forgejoClient({ token: "t", apiUrl: FJ_API, fetch: f });

describe("Forgejo: the one comment (#1064)", () => {
  const args = { repo: "acme/infra", number: 7, body: "<!-- behold:changed -->\nbody", marker: "behold:changed" };

  it("creates the comment on the first push, with the token scheme Forgejo takes", async () => {
    const fj = recorded([...fjList("forgejo-comments-empty.json"), fjCreate]);
    expect(await forgejoUpsert(fjClient(fj.fetch), args)).toMatchObject({ action: "created", url: "https://forgejo.example.com/acme/infra/pulls/7#issuecomment-2152" });
    expect(fj.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(fj.calls[0]!.headers.authorization).toBe("token t");
  });

  it("edits the one comment on a second push, found on the second page of 50", async () => {
    const fj = recorded([...fjList("forgejo-comments-page1.json", "forgejo-comments-page2.json"), fjEdit, fjCreate]);
    expect(await forgejoUpsert(fjClient(fj.fetch), args)).toMatchObject({ action: "updated" });
    expect(fj.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /api/v1/repos/acme/infra/issues/7/comments", "GET /api/v1/repos/acme/infra/issues/7/comments", "PATCH /api/v1/repos/acme/infra/issues/comments/2151"]);
    expect(fj.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("follows a Link header when the instance sends one", async () => {
    const fj = recorded([
      { method: "GET", path: /limit=50&page=1$/, file: "forgejo-comments-page1.json", headers: { link: `<${FJ_API}/repos/acme/infra/issues/7/comments?limit=50&page=2>; rel="next"` } },
      { method: "GET", path: /limit=50&page=2$/, file: "forgejo-comments-page2.json" },
      fjEdit,
    ]);
    expect((await forgejoUpsert(fjClient(fj.fetch), args)).action).toBe("updated");
  });

  it("answers denied for the read-only token of a fork's run", async () => {
    const fj = recorded([...fjList("forgejo-comments-empty.json"), { ...fjCreate, status: 403, file: "forgejo-forbidden.json" }]);
    expect(await forgejoUpsert(fjClient(fj.fetch), args)).toEqual({ action: "denied", status: 403 });
  });
});

describe("Forgejo: the job (#1064)", () => {
  async function readFirst(event: string, extra: Record<string, string> = {}) {
    const r = repo([FIRST, SECOND]);
    const env = fjEnv(r, event, extra);
    const inputs = readInputs(env);
    const result = await readChanged({ env, inputs, behold: behold1, log: quiet });
    return { r, env, inputs, result, summary: () => readFileSync(env.GITHUB_STEP_SUMMARY!, "utf8") };
  }

  it("is picked by FORGEJO_ACTIONS, which Forgejo Actions sets alongside GITHUB_ACTIONS", () => {
    expect(detectForge({ FORGEJO_ACTIONS: "true", GITHUB_ACTIONS: "true" })).toBe("forgejo");
    expect(detectForge({ GITHUB_ACTIONS: "true" })).toBe("github");
  });

  it.skipIf(gate)("writes the summary and creates one comment, linking the run by its number", { timeout: 240_000 }, async () => {
    const { env, inputs, result, summary } = await readFirst("event-pull-request-forgejo.json");
    expect(result).toMatchObject({ ok: true, forge: "forgejo", fork: false, number: 7 });
    const body = readFileSync(join(inputs.out, "comment.md"), "utf8");
    expect(body).toContain("https://forgejo.example.com/acme/infra/actions/runs/12");
    const fj = recorded([...fjList("forgejo-comments-empty.json"), fjCreate]);
    const out = await report({ env, inputs, gh: fjClient(fj.fetch), log: quiet });
    expect(out.action).toBe("created");
    expect(JSON.parse(fj.calls[1]!.body!).body).toBe(body);
    expect(summary()).toContain("```mermaid");
    expect(summary()).toContain("## behold: what this pull request changes");
  });

  it.skipIf(gate)("a second push edits that comment", { timeout: 240_000 }, async () => {
    const { env, inputs } = await readFirst("event-pull-request-forgejo.json");
    const fj = recorded([...fjList("forgejo-comments-page1.json", "forgejo-comments-page2.json"), fjEdit, fjCreate]);
    expect((await report({ env, inputs, gh: fjClient(fj.fetch), log: quiet })).action).toBe("updated");
  });

  it.skipIf(gate)("a fork's run makes no API call and leaves only the summary", { timeout: 240_000 }, async () => {
    const { env, inputs, summary } = await readFirst("event-pull-request-forgejo-fork.json");
    const fj = recorded([]);
    expect((await report({ env, inputs, gh: fjClient(fj.fetch), log: quiet })).action).toBe("fork");
    expect(fj.calls).toEqual([]);
    expect(summary()).toContain("read-only token and no secrets");
    expect(summary()).toContain("```mermaid");
  });

  it("refuses post-comment: Forgejo has no workflow_run event", async () => {
    const env = { FORGEJO_ACTIONS: "true", GITHUB_EVENT_PATH: "/nowhere", GITHUB_REPOSITORY: "acme/infra" };
    await expect(postComment({ env, inputs: readInputs(env), gh: fjClient(recorded([]).fetch) })).rejects.toThrow(/only GitHub has/);
  });
});

describe("the CI files (#1064)", () => {
  const read = (p: string): string => readFileSync(join(import.meta.dirname, "..", p), "utf8");

  it("the GitLab template runs on merge request events, needs a pinned action ref and keeps the token out of the script text", () => {
    const yml = read("gitlab/behold.gitlab-ci.yml");
    expect(yml).toContain('$CI_PIPELINE_SOURCE == "merge_request_event"');
    expect(yml).toContain("BEHOLD_ACTION_REF");
    expect(yml).toContain("expose_as");
    expect(yml).not.toMatch(/glpat-/);
  });

  it("the Forgejo workflow pins every action to a commit and swaps the artifact steps", () => {
    const yml = read("forgejo/behold.yml");
    const uses = [...yml.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
    expect(uses.filter((u) => !/INTENTIUS\/behold@/.test(u)).every((u) => /@[0-9a-f]{40}$/.test(u))).toBe(true);
    expect(yml).toContain('upload: "false"');
    expect(yml).toContain("forgejo/upload-artifact");
    expect(yml).not.toContain("workflow_run");
  });

  it("the action accepts a forge input", () => {
    const yml = readFileSync(join(import.meta.dirname, "..", "..", "action.yml"), "utf8");
    expect(yml).toMatch(/^ {2}forge:/m);
    expect(yml).toContain("INPUT_FORGE");
  });
});
