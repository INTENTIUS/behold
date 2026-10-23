import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import {
  SHOT_PEER_PKG,
  ShotRefusal,
  installLines,
  launchShotBrowser,
  queryView,
  shotPeer,
  shotQueue,
  shotUrls,
  takeShot,
  type ShotBrowser,
  type ShotChromium,
  type ShotDeps,
  type ShotPage,
} from "./shot.ts";
import { parseShotArgs, runShot } from "./shot-cli.ts";

// behold#915: the shot's own logic, with a stand-in browser. src/shot-browser.test.ts
// takes real pictures where a browser is installed.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Fake {
  deps: ShotDeps;
  launches: Array<{ channel?: string }>;
  closed: number;
  pages: string[];
}

/** A stand-in chromium. `fail` lists the launches that throw; `page` says what the page does. */
function fakeBrowser({ fail = [] as string[], ready = true, state = "drawn", cards = 3 } = {}): Fake {
  const f: Fake = { deps: {}, launches: [], closed: 0, pages: [] };
  const page: ShotPage = {
    goto: async (url) => void f.pages.push(url),
    waitForFunction: async (_fn, _arg, opts) => {
      if (!ready) throw new Error(`Timeout ${opts.timeout}ms exceeded.`);
    },
    evaluate: (async () => ({ state, cards, lit: cards ? 1 : 0, viewBox: "0 0 100 60" })) as ShotPage["evaluate"],
    screenshot: async () => PNG,
  };
  const browser: ShotBrowser = { newPage: async () => page, close: async () => void f.closed++ };
  const chromium: ShotChromium = {
    launch: async (opts) => {
      f.launches.push(opts);
      const which = opts.channel === "chrome" ? "chrome" : "headless-shell";
      if (fail.includes(which)) throw new Error(`${which} is not installed\nlong log`);
      return browser;
    },
  };
  f.deps = { chromium: () => chromium };
  return f;
}

const noPeer: ShotDeps = { chromium: () => null };

describe("queryView: the query -> view step (behold#915, filled in by #913)", () => {
  it("passes a query through as the view's q (behold#913), a leading -> included", () => {
    expect(queryView({ query: "kind:Bucket" })).toEqual({ q: "kind:Bucket" });
    expect(queryView({ query: "->kind:aws_kms_key", env: "prod", view: { zoom: "resources" } })).toEqual({ zoom: "resources", env: "prod", q: "->kind:aws_kms_key" });
  });

  it("passes the stand-in selection, env and snapshot through", () => {
    expect(queryView({ query: "", env: "prod", snapshot: "latest", view: { node: "a", zoom: "resources" } })).toEqual({ env: "prod", snapshot: "latest", node: "a", zoom: "resources" });
  });

  it("refuses a snapshot without an env, a bad env, a key a shot takes not, and nothing to frame", () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as ShotRefusal).code;
      }
    };
    expect(code(() => queryView({ snapshot: "latest", view: { node: "a" } }))).toBe("bad-request");
    expect(code(() => queryView({ env: "../x", view: { node: "a" } }))).toBe("bad-request");
    expect(code(() => queryView({ view: { node: "a", embed: "1" } }))).toBe("bad-request");
    expect(code(() => queryView({ view: { zoom: "resources" } }))).toBe("bad-request");
    expect(code(() => queryView({ query: "a\nb" }))).toBe("bad-request");
  });
});

describe("shotUrls", () => {
  it("loads the page with the frame on, and links the same view without it", () => {
    const { page, link } = shotUrls("http://127.0.0.1:5000/", { env: "prod", node: "aws_vpc.main" }, "https://views.example/estate");
    expect(page).toBe("http://127.0.0.1:5000/?env=prod&node=aws_vpc.main&embed=1&bare=1&frame=matches");
    expect(link).toBe("https://views.example/estate/?env=prod&node=aws_vpc.main");
  });
});

describe("the headless-browser peer", () => {
  it("reads its range from behold's own peerDependencies, and finds the installed one", () => {
    const peer = shotPeer();
    expect(peer.pkg).toBe(SHOT_PEER_PKG);
    expect(peer.range).toMatch(/^\^1\./);
    expect(installLines(peer.range)).toContain(`npm i -g playwright-core@${peer.range}`);
    expect(installLines(peer.range)).toContain("npx playwright-core install chromium-headless-shell");
  });

  it("is refused with the install lines when the peer is missing", async () => {
    const e = await launchShotBrowser(noPeer).catch((err: ShotRefusal) => err);
    expect(e).toBeInstanceOf(ShotRefusal);
    expect((e as ShotRefusal).code).toBe("no-browser");
    expect((e as ShotRefusal).body.remedy).toContain("npm i -g playwright-core@");
  });

  it("tries the system Chrome first, then the headless shell", async () => {
    const f = fakeBrowser({ fail: ["chrome"] });
    const got = await launchShotBrowser(f.deps);
    expect(got.which).toBe("headless-shell");
    expect(f.launches).toEqual([{ channel: "chrome", headless: true }, { headless: true }]);
    expect((await launchShotBrowser(fakeBrowser().deps)).which).toBe("chrome");
  });

  it("is refused, naming both, when neither launches", async () => {
    const e = (await launchShotBrowser(fakeBrowser({ fail: ["chrome", "headless-shell"] }).deps).catch((err) => err)) as ShotRefusal;
    expect(e.code).toBe("no-browser");
    expect(e.body.error).toContain("system Chrome: chrome is not installed");
    expect(e.body.error).toContain("chromium-headless-shell: headless-shell is not installed");
    expect(e.body.error).not.toContain("long log");
  });
});

describe("takeShot", () => {
  it("answers the picture, the state and the link, and closes the browser", async () => {
    const f = fakeBrowser();
    const r = await takeShot("http://127.0.0.1:1", { view: { node: "a" } }, { deps: f.deps, linkBase: "http://localhost:4600" });
    expect(r.png).toEqual(PNG);
    expect(r.state).toBe("drawn");
    expect(r.link).toBe("http://localhost:4600/?node=a");
    expect(r.viewBox).toEqual([0, 0, 100, 60]);
    expect(f.pages[0]).toContain("frame=matches");
    expect(f.closed).toBe(1);
  });

  it("refuses a page that never reports ready, and closes the browser", async () => {
    const f = fakeBrowser({ ready: false });
    const e = (await takeShot("http://127.0.0.1:1", { view: { node: "a" }, timeoutMs: 50 }, { deps: f.deps }).catch((err) => err)) as ShotRefusal;
    expect(e.code).toBe("not-ready");
    expect(e.status).toBe(504);
    expect(f.closed).toBe(1);
  });

  it("refuses a drawn page with no cards, but photographs a failed one", async () => {
    const empty = (await takeShot("http://x", { view: { node: "a" } }, { deps: fakeBrowser({ cards: 0 }).deps }).catch((err) => err)) as ShotRefusal;
    expect(empty.code).toBe("not-ready");
    const failed = await takeShot("http://x", { view: { node: "a" } }, { deps: fakeBrowser({ cards: 0, state: "failed" }).deps });
    expect(failed.state).toBe("failed");
  });

  it("never launches a browser for a request it refuses", async () => {
    const f = fakeBrowser();
    await expect(takeShot("http://x", { query: "", env: "prod", snapshot: "latest", view: {} }, { deps: f.deps })).rejects.toBeInstanceOf(ShotRefusal);
    expect(f.launches).toEqual([]);
  });
});

describe("shotQueue", () => {
  it("runs one at a time, and a failure does not stop the next", async () => {
    const one = shotQueue();
    const seen: string[] = [];
    const slow = one(async () => {
      seen.push("a start");
      await new Promise((r) => setTimeout(r, 20));
      seen.push("a end");
      throw new Error("a");
    });
    const next = one(async () => void seen.push("b"));
    await expect(slow).rejects.toThrow("a");
    await next;
    expect(seen).toEqual(["a start", "a end", "b"]);
  });
});

describe("behold shot (the CLI)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) } };
  };

  it("reads the query, the project dir and the flags", () => {
    const a = parseShotArgs(["->kind:Bucket", "proj", "--env", "prod", "--snapshot", "latest", "-o", "x.png", "--view", "node=a&zoom=resources", "--width", "800"], "/w");
    expect(a).toMatchObject({ projectDir: "/w/proj", out: "/w/x.png", req: { query: "->kind:Bucket", env: "prod", snapshot: "latest", width: 800, view: { node: "a", zoom: "resources" } } });
    expect(() => parseShotArgs([])).toThrow(/give the query/);
    expect(() => parseShotArgs(["q", "--at", "x"])).toThrow(/unexpected argument '--at'/);
    expect(() => parseShotArgs(["q", "--url", "file:///etc"])).toThrow(/http/);
  });

  it("refuses without the peer: the install line, a non-zero exit and no file", async () => {
    const d = mkdtempSync(join(tmpdir(), "behold-shot-cli-"));
    dirs.push(d);
    const o = io();
    const out = join(d, "out.png");
    const code = await runShot(["", "--view", "node=a", "--url", "http://127.0.0.1:9", "-o", out], o.io, noPeer);
    expect(code).toBe(1);
    expect(o.err.join("")).toContain("npm i -g playwright-core@");
    expect(o.err.join("")).toContain("nothing written");
    expect(existsSync(out)).toBe(false);
  });

  it("writes no file when the page never reports ready", async () => {
    const d = mkdtempSync(join(tmpdir(), "behold-shot-cli-"));
    dirs.push(d);
    const o = io();
    const code = await runShot(["", "--view", "node=a", "--url", "http://127.0.0.1:9", "-o", join(d, "out.png")], o.io, fakeBrowser({ ready: false }).deps);
    expect(code).toBe(1);
    expect(o.err.join("")).toContain("not-ready");
    expect(readdirSync(d)).toEqual([]);
  });

  it("writes the PNG and prints its path and the link; a failed graph exits 1 with its picture", async () => {
    const d = mkdtempSync(join(tmpdir(), "behold-shot-cli-"));
    dirs.push(d);
    const o = io();
    const out = join(d, "out.png");
    expect(await runShot(["", "--view", "node=a", "--url", "http://127.0.0.1:9", "-o", out], o.io, fakeBrowser().deps)).toBe(0);
    expect(o.out.join("")).toBe(`${out}\nhttp://127.0.0.1:9/?node=a\n`);
    expect(existsSync(out)).toBe(true);
    expect(await runShot(["", "--view", "node=a", "--url", "http://127.0.0.1:9", "-o", join(d, "f.png")], io().io, fakeBrowser({ state: "failed" }).deps)).toBe(1);
    expect(existsSync(join(d, "f.png"))).toBe(true);
  });
});

describe("GET /api/shot", () => {
  const app = (extra: Record<string, unknown> = {}) => createApp({ projectDir: tmpdir(), port: 0, ...extra });

  it("answers PNG bytes with the view's link in a header, never a path", async () => {
    const res = await app({ shotDeps: fakeBrowser().deps }).request("http://localhost/api/shot?node=a&env=prod");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("behold-view-link")).toBe("http://localhost/?env=prod&node=a");
    expect(res.headers.get("behold-shot-state")).toBe("drawn");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it("answers 501 no-browser with the install line without the peer", async () => {
    const res = await app({ shotDeps: noPeer }).request("http://localhost/api/shot?node=a");
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string; remedy: string };
    expect(body.code).toBe("no-browser");
    expect(body.remedy).toContain("npm i -g playwright-core@");
  });

  it("photographs a query's view (behold#913), and answers 400 for nothing to frame", async () => {
    const f = fakeBrowser();
    const a = app({ shotDeps: f.deps });
    const q = await a.request("http://localhost/api/shot?q=kind%3ABucket");
    expect(q.status).toBe(200);
    expect(q.headers.get("behold-view-link")).toContain("q=kind%3ABucket");
    expect(f.pages[0]).toContain("q=kind%3ABucket");
    expect(f.pages[0]).toContain("frame=matches");
    expect(f.launches.length).toBe(1);
    expect((await a.request("http://localhost/api/shot")).status).toBe(400);
    expect(f.launches.length).toBe(1);
  });

  it("is refused on a --public serve, before any browser starts", async () => {
    const f = fakeBrowser();
    const res = await app({ public: true, shotDeps: f.deps }).request("http://localhost/api/shot?node=a");
    expect(res.status).toBe(403);
    expect(f.launches).toEqual([]);
  });

  it("is listed in the API index", async () => {
    const body = (await (await app().request("http://localhost/api")).json()) as { routes: Array<{ method: string; path: string }> };
    expect(body.routes.some((r) => r.method === "GET" && r.path === "/api/shot")).toBe(true);
  });
});
