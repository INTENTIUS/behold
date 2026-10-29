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
import { actionEngineRefusal, checkRequest, gitlabActionLine, gitlabRequestLine, gitlabRolloutLine, requestBranch, requestWorkflowInputs, rolloutBranch, type RequestRecord, type TemplateRow, type TemplatesIo, type TerragucciRun } from "./templates.ts";

// behold#1035: the Templates routes. Each test builds a repo in a temp dir and
// hands the app spies for terragucci, gh and fetch; nothing reaches a forge.
const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "templates");
const CATALOG = readFileSync(join(FIX, "templates-list.json"), "utf8");
const ROWS = (JSON.parse(CATALOG) as { results: TemplateRow[] }).results;
const WORKFLOW = readFileSync(join(FIX, "terragucci-request.yml"), "utf8");
const WORKFLOW_CLAIMED = readFileSync(join(FIX, "terragucci-request-claimed.yml"), "utf8");
// behold#1036: terragucci's own rendered request workflow (with `app`) and rollout workflow (with `module` and `version`).
const WORKFLOW_ADDON = readFileSync(join(FIX, "terragucci-request-addon.yml"), "utf8");
const ROLLOUT = readFileSync(join(FIX, "terragucci-rollout.yml"), "utf8");
const APPS = readFileSync(join(FIX, "templates-apps.json"), "utf8");
// behold#1037: terragucci's rendered action workflow (terragucci#1310's golden, dispatch inputs `root` and `address`).
const ACTION = readFileSync(join(FIX, "terragucci-action.yml"), "utf8");

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

/** terragucci answering the fixture catalog (and with `templates apps`, the fixture apps), counting its runs. */
function tgSpy(): TerragucciRun & { calls: { cwd: string; args: string[] }[] } {
  const calls: { cwd: string; args: string[] }[] = [];
  const f = (async (cwd: string, args: string[]) => {
    calls.push({ cwd, args });
    return { code: 0, stdout: args[1] === "apps" ? APPS : CATALOG, stderr: "" };
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
    // behold#1037 allowlists /api/templates/action; an approve route never is.
    for (const path of ["/api/ci/dispatch", "/api/apply?env=prod", "/api/templates/approve", "/api/templates/action/approve"]) {
      const res = await a.request(path, post({}));
      expect(res.status, path).toBe(409);
      expect(((await res.json()) as { code: string }).code, path).toBe("terragucci");
    }
    expect((await a.request("/api/templates/request", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(409);
    expect((await a.request("/api/templates/action", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(409);
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

// behold#1036: the apps, an add-on request into one, and an upgrade the rollout carries.
const addonRepo = (extra: Record<string, string> = {}) => githubRepo(WORKFLOW_ADDON, { ".github/workflows/terragucci-rollout.yml": ROLLOUT, ...extra });
const addon = { template: "acme/queue-addon/aws", version: "0.3.0", name: "queue", app: "orders", inputs: {} };

describe("GET /api/templates/apps (behold#1036)", () => {
  it("answers what the repo's own terragucci templates apps --json printed, byte for byte", async () => {
    const stub = `import { readFileSync } from "node:fs";\nconst a = process.argv.slice(2).join(" ");\nif (a !== "templates apps --json") { process.stderr.write("unexpected " + a); process.exit(2); }\nprocess.stdout.write(readFileSync(${JSON.stringify(join(FIX, "templates-apps.json"))}));\n`;
    const dir = addonRepo({
      "node_modules/@intentius/terragucci/package.json": JSON.stringify({ name: "@intentius/terragucci", version: "0.4.47", bin: { terragucci: "dist/terragucci.mjs" } }),
      "node_modules/@intentius/terragucci/dist/terragucci.mjs": stub,
    });
    const before = tree(dir);
    const res = await app(dir, {}).request("/api/templates/apps");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe(APPS);
    expect(tree(dir)).toEqual(before);
  });

  it("refuses a terragucci whose templates command has no apps as terragucci-too-old", async () => {
    const old: TerragucciRun = async () => ({ code: 1, stdout: "", stderr: "terragucci: usage: terragucci templates [list | show <template>] [--registry <url>] [--json] [--config <file>]\n" });
    const res = await app(addonRepo(), { terragucci: old }).request("/api/templates/apps");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("terragucci-too-old");
  });
});

describe("POST /api/templates/request with app: an add-on (behold#1036)", () => {
  it("dispatches terragucci-request.yml with the app input, on the add-on's branch", async () => {
    const dir = addonRepo();
    const gh = ghSpy();
    const a = app(dir, { terragucci: tgSpy(), gh, ...quick });
    const before = tree(dir);
    const res = await a.request("/api/templates/request", post(addon));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; branch: string; app: string };
    expect(body).toMatchObject({ branch: "request/queue-addon/orders/queue", app: "orders" });
    const runs = gh.calls.filter((c) => c.args[0] === "workflow");
    expect(runs).toHaveLength(1);
    // terragucci's rendered workflow declares claimed_by too, so the person behold resolved goes after app.
    expect(runs[0]!.args.slice(0, 13)).toEqual(["workflow", "run", "terragucci-request.yml", "-f", "template=acme/queue-addon/aws", "-f", "version=0.3.0", "-f", "name=queue", "-f", "inputs={}", "-f", "app=orders"]);
    expect(runs[0]!.args.slice(13).filter((x) => x !== "-f").every((x) => x.startsWith("claimed_by="))).toBe(true);
    expect(await ended(a, body.id)).toMatchObject({ kind: "addon", app: "orders", conclusion: "success", pull_request: 7 });
    expect(gh.calls.some((c) => c.args.join(" ").startsWith("pr list --head request/queue-addon/orders/queue "))).toBe(true);
    expect(tree(dir)).toEqual(before);
  });

  it("answers 422 not-an-app for an app the repo does not have, and dispatches nothing", async () => {
    const gh = ghSpy();
    const res = await app(addonRepo(), { terragucci: tgSpy(), gh, ...quick }).request("/api/templates/request", post({ ...addon, app: "billing" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; field: string; error: string };
    expect(body.code).toBe("not-an-app");
    expect(body.field).toBe("app");
    expect(body.error).toContain("orders, search");
    expect(gh.calls).toHaveLength(0);
  });

  it("answers addon-exists for a name the app already uses, and wrong-kind for an app template with app", async () => {
    const gh = ghSpy();
    const a = app(addonRepo(), { terragucci: tgSpy(), gh, ...quick });
    const taken = await a.request("/api/templates/request", post({ ...addon, name: "cache" }));
    expect(taken.status).toBe(422);
    expect(((await taken.json()) as { code: string }).code).toBe("addon-exists");
    const kind = await a.request("/api/templates/request", post({ ...valid, app: "orders" }));
    expect(kind.status).toBe(422);
    expect(((await kind.json()) as { code: string }).code).toBe("wrong-kind");
    expect(gh.calls).toHaveLength(0);
  });

  it("takes an app.<output> value on an add-on, which only an add-on may name", () => {
    const rows: TemplateRow[] = [...ROWS, { template: "acme/cache/aws", name: "cache", kind: "addon", versions: [{ version: "0.3.0", attestation: "signed" }], latest: "0.3.0", fields: [{ name: "subnet_ids", kind: "list", of: "string", required: true }] }];
    expect(checkRequest(rows, { template: "acme/cache/aws", name: "cache", app: "orders", inputs: { subnet_ids: "app.private_subnets" } }).ok).toBe(true);
    const app2 = checkRequest(rows, { ...valid, inputs: { bucket_name: "x", readers: "app.readers" } });
    expect(app2.ok ? "ok" : app2.refusal.body.code).toBe("input-type");
    expect(requestBranch("acme/cache/aws", "cache", "orders")).toBe("request/cache/orders/cache");
  });
});

describe("POST /api/templates/upgrade (behold#1036)", () => {
  it("runs gh workflow run terragucci-rollout.yml with the app's template as module and its upgrade as version", async () => {
    const dir = addonRepo();
    const gh = ghSpy();
    const tg = tgSpy();
    const a = app(dir, { terragucci: tg, gh, ...quick });
    const before = tree(dir);
    const res = await a.request("/api/templates/upgrade", post({ app: "orders", version: "1.3.0" }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; workflow: string; from: string; version: string; branch: string };
    expect(body).toMatchObject({ workflow: "terragucci-rollout.yml", from: "1.2.0", version: "1.3.0", branch: "terragucci/rollout/acme-bucket-aws-1.3.0/wave-1" });
    const runs = gh.calls.filter((c) => c.args[0] === "workflow");
    expect(runs).toHaveLength(1);
    expect(["gh", ...runs[0]!.args].join(" ")).toBe("gh workflow run terragucci-rollout.yml -f module=acme/bucket/aws -f version=1.3.0");
    expect(runs[0]!.cwd).toBe(dir);
    expect(tg.calls.map((c) => c.args.join(" "))).toEqual(["templates apps --json"]);
    expect(await ended(a, body.id)).toMatchObject({ kind: "upgrade", app: "orders", workflow: "terragucci-rollout.yml", conclusion: "success", pull_request: 7 });
    // Never terragucci rollout here, never an apply: gh's dispatch and reads only.
    expect(gh.calls.every((c) => ["auth", "workflow", "run", "pr"].includes(c.args[0]!))).toBe(true);
    expect(tree(dir)).toEqual(before);
  });

  it("refuses an app with no upgrade, a version that is not the upgrade, and an app the repo does not have", async () => {
    const gh = ghSpy();
    const a = app(addonRepo(), { terragucci: tgSpy(), gh, ...quick });
    const none = await a.request("/api/templates/upgrade", post({ app: "search" }));
    expect(none.status).toBe(422);
    expect(((await none.json()) as { code: string }).code).toBe("no-upgrade");
    const stale = await a.request("/api/templates/upgrade", post({ app: "orders", version: "1.4.0" }));
    expect(stale.status).toBe(409);
    expect((await stale.json()) as { code: string; upgrade: string }).toMatchObject({ code: "stale-upgrade", upgrade: "1.3.0" });
    const billing = await a.request("/api/templates/upgrade", post({ app: "billing" }));
    expect(billing.status).toBe(422);
    expect(((await billing.json()) as { code: string }).code).toBe("not-an-app");
    expect(gh.calls).toHaveLength(0);
  });

  it("refuses when the rollout workflow is not committed, or takes no module and version", async () => {
    const gh = ghSpy();
    const missing = await app(githubRepo(WORKFLOW_ADDON), { terragucci: tgSpy(), gh }).request("/api/templates/upgrade", post({ app: "orders" }));
    expect(missing.status).toBe(409);
    expect(((await missing.json()) as { code: string }).code).toBe("no-rollout-workflow");
    const scheduleOnly = "name: terragucci-rollout\non:\n  schedule:\n    - cron: '*/15 * * * *'\n  workflow_dispatch: {}\njobs: {}\n";
    const old = await app(githubRepo(WORKFLOW_ADDON, { ".github/workflows/terragucci-rollout.yml": scheduleOnly }), { terragucci: tgSpy(), gh }).request("/api/templates/upgrade", post({ app: "orders" }));
    expect(old.status).toBe(409);
    expect(((await old.json()) as { code: string }).code).toBe("terragucci-too-old");
    expect(gh.calls).toHaveLength(0);
  });

  it("on Forgejo posts the rollout dispatch with module and version", async () => {
    const dir = repo({ ".git/HEAD": "ref: refs/heads/main\n", ".git/config": gitConfig("git@forgejo.example:acme/infra.git"), "terragucci.yml": "forge: forgejo\ntemplates: {}\n", ".forgejo/workflows/terragucci-rollout.yml": ROLLOUT });
    const seen: { url: string; method: string; body?: unknown }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith("/repos/acme/infra")) return Response.json({ default_branch: "main" });
      if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
      if (url.includes("/pulls")) return Response.json([{ number: 9, html_url: "https://forgejo.example/acme/infra/pulls/9", head: { ref: "terragucci/rollout/acme-bucket-aws-1.3.0/wave-1" } }]);
      return new Response("not found", { status: 404 });
    };
    const a = app(dir, { terragucci: tgSpy(), fetch, env: { FORGEJO_TOKEN: "t0ken" }, ...quick });
    const res = await a.request("/api/templates/upgrade", post({ app: "orders" }));
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    const dispatch = seen.filter((s) => s.method === "POST");
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]!.url).toBe("https://forgejo.example/api/v1/repos/acme/infra/actions/workflows/terragucci-rollout.yml/dispatches");
    expect(dispatch[0]!.body).toMatchObject({ ref: "main", inputs: { module: "acme/bucket/aws", version: "1.3.0" } });
    expect(await ended(a, id)).toMatchObject({ pull_request: 9 });
  });

  it("answers GitLab with the terragucci rollout line, and refuses on its own off a terragucci repo with templates", async () => {
    const gitlab = repo({ ".git/HEAD": "", ".git/config": gitConfig("https://gitlab.example/acme/infra.git"), "terragucci.yml": "forge: gitlab\ntemplates: {}\n" });
    const gh = ghSpy();
    const g = await app(gitlab, { terragucci: tgSpy(), gh }).request("/api/templates/upgrade", post({ app: "orders" }));
    expect(g.status).toBe(422);
    expect((await g.json()) as { code: string; command: string }).toMatchObject({ code: "request-forge", command: gitlabRolloutLine("acme/bucket/aws", "1.3.0") });
    expect(gitlabRolloutLine("acme/bucket/aws", "1.3.0")).toBe("npx terragucci rollout acme/bucket/aws 1.3.0 --mode apply");
    const tg = tgSpy();
    const yodel = await app(repo({ ".git/HEAD": "", "yodel.config.ts": "export default {};\n" }), { terragucci: tg, gh }).request("/api/templates/upgrade", post({ app: "orders" }));
    expect(yodel.status).toBe(409);
    expect(((await yodel.json()) as { code: string }).code).toBe("sql-yodeler");
    const bare = await app(repo({ ".git/HEAD": "", "terragucci.yml": "binary: tofu\n" }), { terragucci: tg, gh }).request("/api/templates/upgrade", post({ app: "orders" }));
    expect(bare.status).toBe(409);
    expect(((await bare.json()) as { code: string }).code).toBe("no-templates");
    expect(tg.calls).toHaveLength(0);
    expect(gh.calls).toHaveLength(0);
  });

  it("with --public refuses the apps read with 403 and the upgrade with 405", async () => {
    const tg = tgSpy();
    const a = app(addonRepo(), { terragucci: tg }, { public: true });
    expect((await a.request("/api/templates/apps")).status).toBe(403);
    expect((await a.request("/api/templates/upgrade", post({ app: "orders" }))).status).toBe(405);
    expect(tg.calls).toHaveLength(0);
    expect(rolloutBranch("acme/bucket/aws", "1.3.0")).toBe("terragucci/rollout/acme-bucket-aws-1.3.0/wave-1");
  });
});

describe("POST /api/templates/action (behold#1037)", () => {
  const ROTATE = "module.app.action.aws_lambda_invoke.rotate";
  /** A Terraform repo with templates on GitHub, its action workflow committed. */
  const actionRepo = (extra: Record<string, string> = {}) => githubRepo(WORKFLOW_ADDON, { "terragucci.yml": "binary: terraform\ntemplates:\n  require: signed\n", ".github/workflows/terragucci-action.yml": ACTION, ...extra });

  it("runs gh workflow run terragucci-action.yml with exactly root and address, and follows the run", async () => {
    const dir = actionRepo();
    const gh = ghSpy();
    const tg = tgSpy();
    const a = app(dir, { terragucci: tg, gh, ...quick });
    const before = tree(dir);
    const res = await a.request("/api/templates/action", post({ root: "apps/orders", address: ROTATE }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; workflow: string; app: string; action: string; note: string };
    expect(body).toMatchObject({ dispatched: true, workflow: "terragucci-action.yml", app: "orders", root: "apps/orders", address: ROTATE, action: "rotate" });
    expect(body.note).toContain("terragucci approve action apps/orders --plan <digest>");
    const runs = gh.calls.filter((c) => c.args[0] === "workflow");
    expect(runs).toHaveLength(1);
    expect(["gh", ...runs[0]!.args].join(" ")).toBe(`gh workflow run terragucci-action.yml -f root=apps/orders -f address=${ROTATE}`);
    expect(runs[0]!.cwd).toBe(dir);
    expect(tg.calls.map((c) => c.args.join(" "))).toEqual(["templates apps --json"]);
    const rec = await ended(a, body.id);
    expect(rec).toMatchObject({ kind: "action", app: "orders", root: "apps/orders", address: ROTATE, name: "rotate", workflow: "terragucci-action.yml", conclusion: "success", run: 42 });
    // An action opens no pull request, so none is looked for; and behold never approves: gh's dispatch and run reads only.
    expect(rec.branch).toBeUndefined();
    expect(gh.calls.some((c) => c.args[0] === "pr")).toBe(false);
    expect(gh.calls.every((c) => ["auth", "workflow", "run"].includes(c.args[0]!))).toBe(true);
    expect(tree(dir)).toEqual(before);
  });

  it("answers 422 unknown-action for an address the template does not list, and starts nothing", async () => {
    const gh = ghSpy();
    const a = app(actionRepo(), { terragucci: tgSpy(), gh, ...quick });
    const res = await a.request("/api/templates/action", post({ root: "apps/orders", address: "module.app.action.aws_lambda_invoke.purge" }));
    expect(res.status).toBe(422);
    expect((await res.json()) as { code: string; actions: string[] }).toMatchObject({ code: "unknown-action", field: "address", actions: [ROTATE] });
    // An app whose templates offer none, and a root no app has.
    const none = await a.request("/api/templates/action", post({ root: "apps/search", address: ROTATE }));
    expect(((await none.json()) as { code: string }).code).toBe("unknown-action");
    const billing = await a.request("/api/templates/action", post({ root: "apps/billing", address: ROTATE }));
    expect(billing.status).toBe(422);
    expect(((await billing.json()) as { code: string }).code).toBe("not-an-app");
    expect(gh.calls).toHaveLength(0);
  });

  it("refuses a root on OpenTofu or choudoufu by the engine's name, and starts nothing (ruling E)", async () => {
    const gh = ghSpy();
    for (const [files, engine] of [
      [{ "terragucci.yml": "binary: tofu\ntemplates: {}\n" }, "OpenTofu (tofu, from binary in terragucci.yml)"],
      [{ "terragucci.yml": "binary: choudoufu\ntemplates: {}\n" }, "choudoufu (choudoufu"],
      [{ "terragucci.yml": "templates: {}\n", ".opentofu-version": "1.13.1\n" }, "OpenTofu (tofu, from .opentofu-version)"],
      [{ "terragucci.yml": "templates: {}\n", "apps/orders/main.tofu": "" }, "OpenTofu (tofu, from .tofu files in apps/orders)"],
    ] as const) {
      const res = await app(actionRepo(files), { terragucci: tgSpy(), gh, ...quick }).request("/api/templates/action", post({ root: "apps/orders", address: ROTATE }));
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("action-engine");
      expect(body.error).toContain(engine);
      expect(body.error).toContain("has no action invocation");
    }
    expect(gh.calls).toHaveLength(0);
    // The page is told too, so the buttons say why rather than vanish.
    const project = (await (await app(actionRepo({ "terragucci.yml": "binary: tofu\ntemplates: {}\n" }), { terragucci: tgSpy(), gh }).request("/api/project")).json()) as { terragucciActionRefusal?: string };
    expect(project.terragucciActionRefusal).toContain("OpenTofu");
    const tf = (await (await app(actionRepo(), { terragucci: tgSpy(), gh }).request("/api/project")).json()) as { terragucciActionRefusal?: string };
    expect(tf.terragucciActionRefusal).toBeUndefined();
    expect(actionEngineRefusal({ root: "/nowhere", binary: "terraform" }, "apps/orders")).toBeUndefined();
  });

  it("refuses when the action workflow is not committed, or takes no root and address", async () => {
    const gh = ghSpy();
    const missing = await app(githubRepo(WORKFLOW_ADDON, { "terragucci.yml": "templates: {}\n" }), { terragucci: tgSpy(), gh }).request("/api/templates/action", post({ root: "apps/orders", address: ROTATE }));
    expect(missing.status).toBe(409);
    expect(((await missing.json()) as { code: string }).code).toBe("no-action-workflow");
    const old = await app(actionRepo({ ".github/workflows/terragucci-action.yml": "name: terragucci action\non:\n  workflow_dispatch: {}\njobs: {}\n" }), { terragucci: tgSpy(), gh }).request("/api/templates/action", post({ root: "apps/orders", address: ROTATE }));
    expect(old.status).toBe(409);
    expect(((await old.json()) as { code: string }).code).toBe("terragucci-too-old");
    expect(gh.calls).toHaveLength(0);
  });

  it("on Forgejo posts the action dispatch with root and address, and follows the run it names", async () => {
    const dir = repo({ ".git/HEAD": "ref: refs/heads/main\n", ".git/config": gitConfig("git@forgejo.example:acme/infra.git"), "terragucci.yml": "forge: forgejo\nbinary: terraform\ntemplates: {}\n", ".forgejo/workflows/terragucci-action.yml": ACTION });
    const seen: { url: string; method: string; body?: unknown }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith("/repos/acme/infra")) return Response.json({ default_branch: "main" });
      if (url.endsWith("/dispatches")) return Response.json({ id: 5, run_number: 5 }, { status: 201 });
      if (url.includes("/actions/runs/5")) return Response.json({ id: 5, status: "success", html_url: "https://forgejo.example/acme/infra/actions/runs/5" });
      return new Response("not found", { status: 404 });
    };
    const a = app(dir, { terragucci: tgSpy(), fetch, env: { FORGEJO_TOKEN: "t0ken" }, ...quick });
    const res = await a.request("/api/templates/action", post({ root: "apps/orders", address: ROTATE }));
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    const dispatch = seen.filter((s) => s.method === "POST");
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]!.url).toBe("https://forgejo.example/api/v1/repos/acme/infra/actions/workflows/terragucci-action.yml/dispatches");
    expect(dispatch[0]!.body).toMatchObject({ ref: "main", inputs: { root: "apps/orders", address: ROTATE } });
    const rec = await ended(a, id);
    expect(rec.kind).toBe("action");
    expect(seen.some((s) => s.url.includes("/pulls"))).toBe(false);
  });

  it("answers GitLab with the terragucci action line, and refuses on its own off a terragucci repo with templates", async () => {
    const gitlab = repo({ ".git/HEAD": "", ".git/config": gitConfig("https://gitlab.example/acme/infra.git"), "terragucci.yml": "forge: gitlab\nbinary: terraform\ntemplates: {}\n" });
    const gh = ghSpy();
    const g = await app(gitlab, { terragucci: tgSpy(), gh }).request("/api/templates/action", post({ root: "apps/orders", address: ROTATE }));
    expect(g.status).toBe(422);
    expect((await g.json()) as { code: string; command: string }).toMatchObject({ code: "request-forge", command: `npx terragucci action apps/orders ${ROTATE}` });
    expect(gitlabActionLine("apps/orders", ROTATE)).toBe(`npx terragucci action apps/orders ${ROTATE}`);
    const tg = tgSpy();
    const yodel = await app(repo({ ".git/HEAD": "", "yodel.config.ts": "export default {};\n" }), { terragucci: tg, gh }).request("/api/templates/action", post({ root: "apps/orders", address: ROTATE }));
    expect(yodel.status).toBe(409);
    expect(((await yodel.json()) as { code: string }).code).toBe("sql-yodeler");
    const bare = await app(repo({ ".git/HEAD": "", "terragucci.yml": "binary: terraform\n" }), { terragucci: tg, gh }).request("/api/templates/action", post({ root: "apps/orders", address: ROTATE }));
    expect(bare.status).toBe(409);
    expect(((await bare.json()) as { code: string }).code).toBe("no-templates");
    expect(tg.calls).toHaveLength(0);
    expect(gh.calls).toHaveLength(0);
  });

  it("with --public answers the action post 405 and starts nothing", async () => {
    const tg = tgSpy();
    const gh = ghSpy();
    const res = await app(actionRepo(), { terragucci: tg, gh }, { public: true }).request("/api/templates/action", post({ root: "apps/orders", address: ROTATE }));
    expect(res.status).toBe(405);
    expect(tg.calls).toHaveLength(0);
    expect(gh.calls).toHaveLength(0);
  });
});
