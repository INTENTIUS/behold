// #914: POST /api/view moves every open tab through /api/events, and writes nothing.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createApp, type ServerOptions } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { byLabel, moveView, viewLink, type MoveContext } from "./view-move.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-view-move-"));
  made.push(dir);
  const all = { "chant.config.json": JSON.stringify({ lexicons: ["aws"], environments: ["dev", "prod"] }), ...files };
  for (const [rel, content] of Object.entries(all)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function app(projectDir: string, extra: Partial<ServerOptions> = {}) {
  const broadcaster = new Broadcaster();
  return createApp({ projectDir, port: 0, ...extra }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir, broadcaster, onDone: () => {} }));
}

const post = (a: ReturnType<typeof app>, body: unknown, headers: Record<string, string> = {}) =>
  a.request("http://127.0.0.1:4600/api/view", {
    method: "POST",
    headers: { host: "127.0.0.1:4600", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** An open tab: the /api/events stream, read until an event of `type` arrives. */
async function openTab(a: ReturnType<typeof app>) {
  const res = await a.request("http://127.0.0.1:4600/api/events", { headers: { host: "127.0.0.1:4600" } });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // The first ping says the stream is open, and the route counts it.
  while (!buf.includes("event: ping")) buf += decoder.decode((await reader.read()).value);
  buf = "";
  return {
    async next(type: string, ms = 1000): Promise<string> {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const m = buf.match(new RegExp(`event: ${type}\\ndata: (.*)\\n`));
        if (m) return m[1];
        const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), until - Date.now()))]);
        if (!chunk || chunk.done) break;
        buf += decoder.decode(chunk.value);
      }
      throw new Error(`no ${type} event within ${ms} ms`);
    },
    close: () => reader.cancel(),
  };
}

/** Every file under a directory with its bytes, to say nothing was written. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = `${statSync(p).mtimeMs}:${readFileSync(p, "utf8")}`;
    }
  };
  walk(dir);
  return out;
}

const ctx = (over: Partial<MoveContext> = {}): MoveContext => ({
  public: false,
  preview: false,
  offer: { envs: ["dev", "prod"] },
  tabs: 1,
  origin: "http://127.0.0.1:4600",
  now: () => new Date("2026-10-23T14:02:11.000Z"),
  newId: () => "7f3a",
  ...over,
});

describe("moveView (#914)", () => {
  it("settles the view with the URL's checks and makes the event", () => {
    const a = moveView({ view: { q: "attr:internetFacing=true", env: "prod", zoom: "resources", snapshot: "latest" }, by: "claude-code via behold mcp" }, ctx());
    expect(a.status).toBe(200);
    expect(a.event).toEqual({
      id: "7f3a",
      movedAt: "2026-10-23T14:02:11.000Z",
      by: "claude-code via behold mcp",
      view: { q: "attr:internetFacing=true", env: "prod", zoom: "resources", snapshot: "latest" },
    });
    expect(a.body).toMatchObject({ id: "7f3a", movedAt: "2026-10-23T14:02:11.000Z", sent: 1, refused: [] });
    expect(a.body.link).toBe("http://127.0.0.1:4600/?zoom=resources&env=prod&q=attr%3AinternetFacing%3Dtrue&snapshot=latest");
    // The moment is movedAt: `at` is a git revision in chant's read contract (behold#908).
    expect(a.body).not.toHaveProperty("at");
  });

  it("names what it can't honour, and still moves what it can", () => {
    const a = moveView({ view: { q: "kind:Bucket", env: "staging", at: "abc123", radial: "yes", colour: "red" } }, ctx());
    expect(a.status).toBe(200);
    expect(a.event!.view).toEqual({ q: "kind:Bucket" });
    const keys = (a.body.refused as { key: string; reason: string }[]).map((r) => r.key).sort();
    expect(keys).toEqual(["at", "colour", "env", "radial"]);
    expect((a.body.refused as { key: string; reason: string }[]).find((r) => r.key === "at")!.reason).toMatch(/git revision.*snapshot/);
  });

  it("refuses a snapshot with no env, since a snapshot is of an env", () => {
    const a = moveView({ view: { q: "x", snapshot: "latest" } }, ctx());
    expect(a.event!.view).toEqual({ q: "x" });
    expect((a.body.refused as { key: string }[])[0].key).toBe("snapshot");
  });

  it("checks q as the URL does: control characters and length are refused, the grammar is chant's", () => {
    expect(moveView({ view: { q: "a\nb" } }, ctx()).status).toBe(400);
    expect(moveView({ view: { q: "x".repeat(2001) } }, ctx()).status).toBe(400);
    expect(moveView({ view: { q: 7 } }, ctx()).status).toBe(400);
    expect(moveView({ view: { q: '->kind:Bucket !"un balanced' } }, ctx()).event!.view.q).toBe('->kind:Bucket !"un balanced');
    expect(moveView({ view: { q: null } }, ctx()).event!.view).toEqual({ q: null });
  });

  it("answers 400 for an empty view, a body that isn't an object, and a bad by", () => {
    expect(moveView({ view: {} }, ctx()).body.code).toBe("view");
    expect(moveView([], ctx()).body.code).toBe("body");
    expect(moveView({ view: { q: "x" }, by: "x".repeat(81) }, ctx()).body.code).toBe("by");
    expect(moveView({ view: { q: "x" }, by: "a\u0007b" }, ctx()).body.code).toBe("by");
    expect(moveView({ view: { q: "x" }, by: 3 }, ctx()).body.code).toBe("by");
  });

  it("answers 409 no-tab with the link when no tab is open", () => {
    const a = moveView({ view: { q: "kind:Bucket" } }, ctx({ tabs: 0 }));
    expect(a.status).toBe(409);
    expect(a.body).toMatchObject({ code: "no-tab", link: "http://127.0.0.1:4600/?q=kind%3ABucket" });
    expect(a.event).toBeUndefined();
  });

  it("refuses under --public and under preview, before reading the body", () => {
    expect(moveView({ view: { q: "x" } }, ctx({ public: true }))).toMatchObject({ status: 403, body: { code: "public" } });
    expect(moveView(null, ctx({ preview: true }))).toMatchObject({ status: 403, body: { code: "preview" } });
  });
});

describe("byLabel (#914)", () => {
  it("defaults to the User-Agent's product token", () => {
    expect(byLabel(undefined, "curl/8.7.1 extra")).toEqual({ ok: true, value: "curl/8.7.1" });
    expect(byLabel("", null)).toEqual({ ok: true, value: "unknown" });
    expect(byLabel(undefined, "x".repeat(200))).toEqual({ ok: true, value: "x".repeat(80) });
  });
});

describe("viewLink (#914)", () => {
  it("writes env= only for a view that sets the source graph on a serve started with an env", () => {
    expect(viewLink("http://h:1", { env: null, q: "a" }, "prod")).toBe("http://h:1/?env=&q=a");
    expect(viewLink("http://h:1", { q: "a" }, "prod")).toBe("http://h:1/?q=a");
  });
});

describe("POST /api/view (#914)", () => {
  it("moves every open tab through /api/events within a second, and writes nothing", async () => {
    const dir = project();
    const before = tree(dir);
    const a = app(dir);
    const tabs = [await openTab(a), await openTab(a)];
    const res = await post(a, { view: { q: "attr:internetFacing=true", env: "prod" }, by: "smoke-agent" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; sent: number; link: string };
    expect(body.sent).toBe(2);
    for (const t of tabs) {
      const ev = JSON.parse(await t.next("view", 1000)) as { id: string; by: string; movedAt: string; view: Record<string, unknown> };
      expect(ev).toMatchObject({ id: body.id, by: "smoke-agent", view: { q: "attr:internetFacing=true", env: "prod" } });
      expect(Date.parse(ev.movedAt)).not.toBeNaN();
    }
    for (const t of tabs) await t.close();
    // Nothing in the project, .behold/layout.json included.
    expect(tree(dir)).toEqual(before);
  });

  it("answers 409 no-tab with the link when no tab is open", async () => {
    const res = await post(app(project()), { view: { q: "kind:Bucket" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "no-tab", link: "http://127.0.0.1:4600/?q=kind%3ABucket" });
  });

  it("refuses an env the project doesn't declare, by name", async () => {
    const a = app(project());
    const t = await openTab(a);
    const res = await post(a, { view: { env: "staging" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { refused: { key: string; reason: string }[] }).refused[0]).toMatchObject({ key: "env", reason: "this estate declares dev, prod" });
    await t.close();
  });

  it("is refused under behold preview, with or without --emulator", async () => {
    for (const extra of [{ preview: true }, { previewMode: true }]) {
      const a = app(project(), extra);
      const t = await openTab(a);
      const res = await post(a, { view: { q: "x" } });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("preview");
      await t.close();
    }
  });

  it("is refused under a --public serve: 405 from the guard, and 403 in the route itself", async () => {
    const a = app(project(), { public: true });
    const res = await post(a, { view: { q: "x" } });
    expect(res.status).toBe(405);
    expect(((await res.json()) as { code: string }).code).toBe("public");
    // Past the guard (were it ever to let a write through), the route still refuses.
    const ctxPublic = moveView({ view: { q: "x" } }, ctx({ public: true }));
    expect(ctxPublic.status).toBe(403);
  });

  it("moves the tab on a terragucci repo, where every other unlisted write is refused", async () => {
    const dir = project({ ".git/HEAD": "", "terragucci.yml": "binary: tofu\n" });
    const a = app(dir);
    const t = await openTab(a);
    const res = await post(a, { view: { q: "kind:Resource" } });
    expect(res.status).toBe(200);
    expect(JSON.parse(await t.next("view"))).toMatchObject({ view: { q: "kind:Resource" } });
    expect((await a.request("http://127.0.0.1:4600/api/apply?env=prod", { method: "POST", headers: { host: "127.0.0.1:4600" } })).status).toBe(409);
    await t.close();
  });

  it("is listed in GET /api", async () => {
    const res = await app(project()).request("/api");
    const routes = ((await res.json()) as { routes: { method: string; path: string; desc: string }[] }).routes;
    const r = routes.find((x) => x.path === "/api/view");
    expect(r?.method).toBe("POST");
    expect(r?.desc).toMatch(/writing nothing/);
  });
});
