import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import type { GhExec } from "./gh-run.ts";
import { checkRequest, gitlabRequestLine, requestWorkflowInputs, type RequestRecord, type TemplateRow, type TemplatesIo, type TerragucciRun } from "./templates.ts";

// behold#1035: the Templates routes. Each test builds a repo in a temp dir and
// hands the app spies for terragucci, gh and fetch; nothing reaches a forge.
const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "templates");
const CATALOG = readFileSync(join(FIX, "templates-list.json"), "utf8");
const ROWS = (JSON.parse(CATALOG) as { results: TemplateRow[] }).results;
const WORKFLOW = readFileSync(join(FIX, "terragucci-request.yml"), "utf8");
const WORKFLOW_CLAIMED = readFileSync(join(FIX, "terragucci-request-claimed.yml"), "utf8");

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-templates-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

const gitConfig = (url: string) => `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;

/** A terragucci repo with templates on GitHub, its request workflow committed. */
const githubRepo = (workflow = WORKFLOW, extra: Record<string, string> = {}) =>
  repo({ ".git/HEAD": "ref: refs/heads/main\n", ".git/config": gitConfig("https://github.com/acme/infra.git"), "terragucci.yml": "binary: tofu\ntemplates:\n  require: signed\n", ".github/workflows/terragucci-request.yml": workflow, ...extra });

const forgejoRepo = () =>
  repo({ ".git/HEAD": "ref: refs/heads/main\n", ".git/config": gitConfig("git@forgejo.example:acme/infra.git"), "terragucci.yml": "forge: forgejo\ntemplates: {}\n", ".forgejo/workflows/terragucci-request.yml": WORKFLOW });

/** Every file under `dir` with its digest: the tree, to show a route wrote nothing. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

function app(projectDir: string, io: TemplatesIo, extra: { public?: boolean; approver?: { as: string } } = {}) {
  const broadcaster = new Broadcaster();
  return createApp({ projectDir, port: 0, templatesIo: io, ...extra }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir, broadcaster, onDone: () => {} }));
}

/** terragucci answering the fixture catalog, counting its runs. */
function tgSpy(): TerragucciRun & { calls: { cwd: string; args: string[] }[] } {
  const calls: { cwd: string; args: string[] }[] = [];
  const f = (async (cwd: string, args: string[]) => {
    calls.push({ cwd, args });
    return { code: 0, stdout: CATALOG, stderr: "" };
  }) as TerragucciRun & { calls: typeof calls };
  f.calls = calls;
  return f;
}

/** gh answering a dispatch, a run that appears and succeeds, and a pull request #7. */
function ghSpy(): GhExec & { calls: { args: string[]; cwd?: string }[] } {
  const calls: { args: string[]; cwd?: string }[] = [];
  let dispatched = false;
  const f = (async (args: string[], opts?: { cwd?: string }) => {
    calls.push({ args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    const [a, b] = args;
    if (a === "auth") return { code: 0, out: "Logged in" };
    if (a === "workflow" && b === "run") {
      dispatched = true;
      return { code: 0, out: "" };
    }
    if (a === "run" && b === "list") return { code: 0, out: JSON.stringify(dispatched ? [{ databaseId: 42 }] : [{ databaseId: 41 }]) };
    if (a === "run" && b === "view") return { code: 0, out: JSON.stringify({ status: "completed", conclusion: "success", jobs: [{ name: "request", status: "completed", conclusion: "success" }], url: "https://github.com/acme/infra/actions/runs/42" }) };
    if (a === "pr" && b === "list") return { code: 0, out: JSON.stringify([{ number: 7, url: "https://github.com/acme/infra/pull/7" }]) };
    return { code: 1, out: `unexpected gh ${args.join(" ")}` };
  }) as GhExec & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const quick = { pollMs: 1, appearTimeoutMs: 2000, followTimeoutMs: 2000, sleep: async () => {} };
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const valid = { template: "acme/bucket/aws", version: "1.2.0", name: "orders", inputs: { bucket_name: "orders-data" } };

async function ended(a: ReturnType<typeof app>, id: string): Promise<RequestRecord> {
  for (let i = 0; i < 200; i++) {
    const rec = (await (await a.request(`/api/templates/requests/${id}`)).json()) as RequestRecord;
    if (rec.state === "ended") return rec;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`request ${id} never ended`);
}

describe("GET /api/templates (behold#1035)", () => {
  it("answers what the repo's own terragucci printed, byte for byte", async () => {
    const stub = `import { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(${JSON.stringify(join(FIX, "templates-list.json"))}));\n`;
    const dir = githubRepo(WORKFLOW, {
      "node_modules/@intentius/terragucci/package.json": JSON.stringify({ name: "@intentius/terragucci", version: "0.4.47", bin: { terragucci: "dist/terragucci.mjs" } }),
      "node_modules/@intentius/terragucci/dist/terragucci.mjs": stub,
    });
    const before = tree(dir);
    const res = await app(dir, {}).request("/api/templates");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe(CATALOG);
    expect(tree(dir)).toEqual(before);
  });

  it("refuses a terragucci without the templates command as terragucci-too-old, naming the floor", async () => {
    const dir = githubRepo();
    const old: TerragucciRun = async () => ({ code: 1, stdout: "", stderr: 'unknown command "templates"\n\nusage: terragucci ...' });
    const res = await app(dir, { terragucci: old }).request("/api/templates");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("terragucci-too-old");
    expect(body.error).toContain("newer than 0.4.46");
  });

  it("refuses a terragucci repo without templates, and a repo that is not terragucci's", async () => {
    const plain = repo({ ".git/HEAD": "", "terragucci.yml": "binary: tofu\n" });
    const tg = tgSpy();
    const res = await app(plain, { terragucci: tg }).request("/api/templates");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("no-templates");
    const none = repo({ ".git/HEAD": "" });
    expect((await app(none, { terragucci: tg }).request("/api/templates")).status).toBe(409);
    expect(tg.calls).toHaveLength(0);
  });

  it("tells the page templates are configured, and only then", async () => {
    const yes = (await (await app(githubRepo(), {}).request("/api/project")).json()) as { terragucciTemplates?: boolean };
    expect(yes.terragucciTemplates).toBe(true);
    const no = (await (await app(repo({ ".git/HEAD": "", "terragucci.yml": "" }), {}).request("/api/project")).json()) as { terragucciTemplates?: boolean };
    expect(no.terragucciTemplates).toBeUndefined();
  });
});

describe("POST /api/templates/request (behold#1035)", () => {
  it("answers 422 missing-input for a required input left out, and starts no process", async () => {
    const dir = githubRepo();
    const tg = tgSpy();
    const gh = ghSpy();
    const fetch = async () => {
      throw new Error("no fetch expected");
    };
    const a = app(dir, { terragucci: tg, gh, fetch, ...quick });
    // The tab's read, as the form is drawn from it.
    expect((await a.request("/api/templates")).status).toBe(200);
    tg.calls.length = 0;
    const before = tree(dir);
    const res = await a.request("/api/templates/request", post({ ...valid, inputs: { retention_days: 7 } }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; field: string };
    expect(body.code).toBe("missing-input");
    expect(body.field).toBe("inputs.bucket_name");
    expect(tg.calls).toHaveLength(0);
    expect(gh.calls).toHaveLength(0);
    expect(tree(dir)).toEqual(before);
  });

  it("on GitHub runs gh workflow run terragucci-request.yml with exactly the four inputs, then reads the pull request", async () => {
    const dir = githubRepo();
    const gh = ghSpy();
    const a = app(dir, { terragucci: tgSpy(), gh, ...quick });
    const before = tree(dir);
    const res = await a.request("/api/templates/request", post(valid));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { dispatched: boolean; id: string; branch: string };
    expect(body.dispatched).toBe(true);
    expect(body.branch).toBe("request/bucket/orders");
    const runs = gh.calls.filter((c) => c.args[0] === "workflow");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.args).toEqual(["workflow", "run", "terragucci-request.yml", "-f", "template=acme/bucket/aws", "-f", "version=1.2.0", "-f", "name=orders", "-f", 'inputs={"bucket_name":"orders-data"}']);
    expect(runs[0]!.cwd).toBe(dir);
    const rec = await ended(a, body.id);
    expect(rec).toMatchObject({ conclusion: "success", run: 42, pull_request: 7, url: "https://github.com/acme/infra/pull/7" });
    expect(gh.calls.some((c) => c.args.join(" ") === "pr list --head request/bucket/orders --state all --limit 1 --json number,url")).toBe(true);
    // Never terragucci request, never anything but gh's dispatch and reads.
    expect(gh.calls.every((c) => ["auth", "workflow", "run", "pr"].includes(c.args[0]!))).toBe(true);
    expect(tree(dir)).toEqual(before);
  });

  it("passes claimed_by only when the committed workflow declares it", async () => {
    const plain = ghSpy();
    await app(githubRepo(), { terragucci: tgSpy(), gh: plain, ...quick }, { approver: { as: "github:ada" } }).request("/api/templates/request", post(valid));
    expect(plain.calls.find((c) => c.args[0] === "workflow")!.args.some((x) => x.startsWith("claimed_by="))).toBe(false);

    const claimed = ghSpy();
    const res = await app(githubRepo(WORKFLOW_CLAIMED), { terragucci: tgSpy(), gh: claimed, ...quick }, { approver: { as: "github:ada" } }).request("/api/templates/request", post(valid));
    expect(((await res.json()) as { claimedBy?: string }).claimedBy).toBe("github:ada");
    expect(claimed.calls.find((c) => c.args[0] === "workflow")!.args.slice(-2)).toEqual(["-f", "claimed_by=github:ada"]);
  });

  it("on Forgejo posts the dispatch to the API with the default branch and the same inputs", async () => {
    const dir = forgejoRepo();
    const seen: { url: string; method: string; body?: unknown; auth?: string }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), ...(h.authorization ? { auth: h.authorization } : {}) });
      if (url.endsWith("/repos/acme/infra")) return Response.json({ default_branch: "trunk" });
      if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
      if (url.includes("/pulls")) return Response.json([{ number: 7, html_url: "https://forgejo.example/acme/infra/pulls/7", head: { ref: "request/bucket/orders" } }]);
      return new Response("not found", { status: 404 });
    };
    const gh = ghSpy();
    const a = app(dir, { terragucci: tgSpy(), gh, fetch, env: { FORGEJO_TOKEN: "t0ken" }, ...quick });
    const before = tree(dir);
    const res = await a.request("/api/templates/request", post(valid));
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    const dispatch = seen.filter((s) => s.method === "POST");
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]!.url).toBe("https://forgejo.example/api/v1/repos/acme/infra/actions/workflows/terragucci-request.yml/dispatches");
    expect(dispatch[0]!.body).toMatchObject({ ref: "trunk", inputs: { template: "acme/bucket/aws", version: "1.2.0", name: "orders", inputs: '{"bucket_name":"orders-data"}' } });
    expect(Object.keys((dispatch[0]!.body as { inputs: object }).inputs)).toEqual(["template", "version", "name", "inputs"]);
    expect(seen.every((s) => s.auth === "token t0ken" && s.url.startsWith("https://forgejo.example/api/v1/repos/acme/infra"))).toBe(true);
    expect(await ended(a, id)).toMatchObject({ pull_request: 7, url: "https://forgejo.example/acme/infra/pulls/7" });
    expect(gh.calls).toHaveLength(0);
    expect(tree(dir)).toEqual(before);
  });

  it("refuses a Forgejo request without FORGEJO_TOKEN before calling anything", async () => {
    let called = 0;
    const res = await app(forgejoRepo(), { terragucci: tgSpy(), fetch: async () => (called++, new Response()), env: {}, ...quick }).request("/api/templates/request", post(valid));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("forge-token");
    expect(called).toBe(0);
  });

  it("answers GitLab with 422 request-forge and the terragucci request line to run", async () => {
    const dir = repo({ ".git/HEAD": "", ".git/config": gitConfig("https://gitlab.example/acme/infra.git"), "terragucci.yml": "forge: gitlab\ntemplates: {}\n" });
    const gh = ghSpy();
    const res = await app(dir, { terragucci: tgSpy(), gh }).request("/api/templates/request", post(valid));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; command: string };
    expect(body.code).toBe("request-forge");
    expect(body.command).toBe("npx terragucci request acme/bucket/aws --name orders --version 1.2.0 --input bucket_name=orders-data");
    expect(gh.calls).toHaveLength(0);
  });

  it("answers a version the catalog no longer offers (yanked) with 422 not-active", async () => {
    const gh = ghSpy();
    const res = await app(githubRepo(), { terragucci: tgSpy(), gh }).request("/api/templates/request", post({ ...valid, version: "1.0.0" }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("not-active");
    expect(gh.calls).toHaveLength(0);
  });

  it("refuses on its own on a SQL Yodeler repo, which shares the allowlist, and on a terragucci repo without templates", async () => {
    const tg = tgSpy();
    const gh = ghSpy();
    const yodel = await app(repo({ ".git/HEAD": "", "yodel.config.ts": "export default {};\n" }), { terragucci: tg, gh }).request("/api/templates/request", post(valid));
    expect(yodel.status).toBe(409);
    expect(((await yodel.json()) as { code: string }).code).toBe("sql-yodeler");
    const bare = await app(repo({ ".git/HEAD": "", "terragucci.yml": "binary: tofu\n", ".github/workflows/terragucci-request.yml": WORKFLOW }), { terragucci: tg, gh }).request("/api/templates/request", post(valid));
    expect(bare.status).toBe(409);
    expect(((await bare.json()) as { code: string }).code).toBe("no-templates");
    expect(tg.calls).toHaveLength(0);
    expect(gh.calls).toHaveLength(0);
  });

  it("leaves every other write refused with 409 terragucci on a terragucci repo with templates", async () => {
    const dir = githubRepo();
    const gh = ghSpy();
    const a = app(dir, { terragucci: tgSpy(), gh });
    for (const path of ["/api/ci/dispatch", "/api/apply?env=prod", "/api/templates/upgrade", "/api/templates/action"]) {
      const res = await a.request(path, post({}));
      expect(res.status, path).toBe(409);
      expect(((await res.json()) as { code: string }).code, path).toBe("terragucci");
    }
    expect((await a.request("/api/templates/request", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(409);
    expect(gh.calls).toHaveLength(0);
  });

  it("with --public refuses the read with 403 and the request with 405", async () => {
    const tg = tgSpy();
    const a = app(githubRepo(), { terragucci: tg }, { public: true });
    expect((await a.request("/api/templates")).status).toBe(403);
    expect((await a.request("/api/templates/requests/x")).status).toBe(403);
    expect((await a.request("/api/templates/request", post(valid))).status).toBe(405);
    expect(tg.calls).toHaveLength(0);
  });
});

describe("the request's checks (behold#1035)", () => {
  it("reads the dispatch inputs the committed workflow declares", () => {
    expect(requestWorkflowInputs(githubRepo(), "github")).toEqual(["template", "version", "name", "inputs"]);
    expect(requestWorkflowInputs(githubRepo(WORKFLOW_CLAIMED), "github")).toEqual(["template", "version", "name", "claimed_by", "inputs"]);
    expect(requestWorkflowInputs(githubRepo(), "forgejo")).toBeUndefined();
  });

  it("refuses a bad name, an add-on, an unknown or sensitive input and a value of the wrong kind", () => {
    const code = (b: Partial<typeof valid> & { inputs?: Record<string, unknown> }) => {
      const r = checkRequest(ROWS, { ...valid, ...b });
      return r.ok ? "ok" : r.refusal.body.code;
    };
    expect(code({})).toBe("ok");
    expect(code({ name: "Orders" })).toBe("bad-name");
    expect(code({ template: "acme/queue-addon/aws", version: "0.3.0" })).toBe("wrong-kind");
    expect(code({ template: "acme/nothing/aws" })).toBe("unknown-version");
    expect(code({ inputs: { bucket_name: "x", colour: "red" } })).toBe("unknown-input");
    expect(code({ inputs: { bucket_name: "x", kms_key: "k" } })).toBe("sensitive-input");
    expect(code({ inputs: { bucket_name: "x", retention_days: "7" } })).toBe("input-type");
    expect(code({ inputs: { bucket_name: "x", readers: ["a", 1] } })).toBe("input-type");
    expect(code({ inputs: { bucket_name: "" } })).toBe("missing-input");
    const latest = checkRequest(ROWS, { template: "acme/bucket/aws", name: "orders", inputs: { bucket_name: "x" } });
    expect(latest.ok && latest.version).toBe("1.2.0");
  });

  it("words the GitLab line so a shell reads every value as one word", () => {
    expect(gitlabRequestLine({ template: "acme/bucket/aws", name: "orders", inputs: { bucket_name: "it's mine", readers: ["a", "b"] } })).toBe(
      `npx terragucci request acme/bucket/aws --name orders --input 'bucket_name=it'\\''s mine' --input 'readers=["a","b"]'`,
    );
  });
});
