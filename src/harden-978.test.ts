// behold#978: the demo host's hardening. Search reads go through the read
// scheduler (src/chant-read-integration.test.ts runs them as real processes),
// the capability catalog is kept per checkout and commit, the caches keyed by
// query values take one spelling of each and refuse the rest, and a public
// view ignores `fresh`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isScheduledRead, isSearchRead } from "./chant.ts";
import { chantComposedFeedRoutes, composedCommit } from "./chant-compose-feed.ts";
import { CHANT_PR_READ_TTL_MS, chantPrRoute, pinKey, pinOf } from "./chant-pr.ts";
import { publicReadRefusal, publicRoutes, withoutFresh } from "./public-mode.ts";
import { isReadBudgetRefusal } from "./read-scheduler.ts";
import { CAPABILITIES_UNCOMMITTED_TTL_MS, cachedCapabilities, type SearchTarget } from "./search.ts";
import { capabilitiesArgv, projectSearchArgv, readArgv, type WorkspaceReader } from "./workspace-reader.ts";

afterEach(() => vi.useRealTimers());

describe("search is a scheduled read (behold#978)", () => {
  it("names every argv a search or a capabilities read runs", () => {
    const argvs = [
      readArgv("search", ["--explain", "--", "kind:aws_vpc"]),
      projectSearchArgv(["--", "kind:aws_vpc"]),
      capabilitiesArgv("workspace"),
      capabilitiesArgv("project"),
    ];
    for (const argv of argvs) {
      expect(isSearchRead(argv)).toBe(true);
      expect(isScheduledRead(argv)).toBe(true);
    }
    expect(isSearchRead(["workspace", "graph"])).toBe(false);
    expect(isScheduledRead(["build"])).toBe(false);
  });

  it("tells the scheduler's own refusals from any other failure", () => {
    expect(isReadBudgetRefusal(new Error("Chant read queue is full; retry after current reads finish"))).toBe(true);
    expect(isReadBudgetRefusal(new Error("Chant read exceeded 180000ms"))).toBe(true);
    expect(isReadBudgetRefusal(new Error("spawn chant ENOENT"))).toBe(false);
    expect(isReadBudgetRefusal("Chant read queue is full")).toBe(false);
  });
});

describe("the capability catalog, kept per checkout and commit (behold#978)", () => {
  const doc = { contract: 1, capabilities: [] };
  function counting(answer: () => Promise<Record<string, unknown>> = async () => doc) {
    let reads = 0;
    const reader = (): WorkspaceReader => ({ readCapabilities: async () => { reads++; return answer(); } }) as unknown as WorkspaceReader;
    return { reader, reads: () => reads };
  }
  const project = (dir: string): SearchTarget => ({ kind: "project", dir, chant: "0.124.46" });

  it("reads a checkout once per commit, and again when the commit moves", async () => {
    let commit: string | undefined = "a".repeat(40);
    const caps = cachedCapabilities({ commitOf: () => commit });
    const { reader, reads } = counting();
    await Promise.all([caps(project("/r"), reader), caps(project("/r"), reader)]);
    await caps(project("/r"), reader);
    expect(reads()).toBe(1);
    await caps(project("/other"), reader);
    expect(reads()).toBe(2);
    commit = "b".repeat(40);
    expect(await caps(project("/r"), reader)).toEqual({ ok: true, document: doc });
    expect(reads()).toBe(3);
  });

  it("keeps a checkout with no readable commit for a while only", async () => {
    let t = 0;
    const caps = cachedCapabilities({ commitOf: () => undefined, now: () => t });
    const { reader, reads } = counting();
    await caps(project("/r"), reader);
    t = CAPABILITIES_UNCOMMITTED_TTL_MS - 1;
    await caps(project("/r"), reader);
    expect(reads()).toBe(1);
    t = CAPABILITIES_UNCOMMITTED_TTL_MS;
    await caps(project("/r"), reader);
    expect(reads()).toBe(2);
  });

  it("never keeps a failed read", async () => {
    const caps = cachedCapabilities({ commitOf: () => "c".repeat(40) });
    const { reader, reads } = counting(async () => ({ contract: 1, error: { message: "no" } }));
    await caps(project("/r"), reader);
    await caps(project("/r"), reader);
    expect(reads()).toBe(2);
  });

  it("a public view refuses the catalog; the kiosk never reads it", () => {
    expect(publicReadRefusal("/api/capabilities", new URLSearchParams())).toMatch(/capability catalog/);
    expect(publicReadRefusal("/api/search", new URLSearchParams("q=kind:aws_vpc"))).toBeUndefined();
  });
});

describe("the pull-request loop's cache takes one spelling of each pin (behold#978)", () => {
  it("spells each pin one way, and anything pinOf can't read as none", () => {
    expect(pinKey(null)).toBeNull();
    expect(pinKey("")).toBeNull();
    expect(pinKey("pull-007")).toBe("pull-7");
    expect(pinKey("pull-7-abcdef1")).toBe("pull-7-abcdef1");
    expect(pinKey("pull")).toBe("pull");
    expect(pinKey("abcdef1")).toBe("abcdef1");
    for (const junk of ["base", "none", "x".repeat(5000), "ABCDEF1", "pull-1-zz"]) expect(pinKey(junk)).toBe("none");
    // The spelling reads back as what the raw pin asked for.
    for (const raw of ["pull-007", "pull-7-abcdef1", "pull", "abcdef1", "junk"]) expect(pinOf(pinKey(raw))).toEqual(pinOf(raw));
  });

  it("shares one read between spellings of a pin, and lets it expire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const dir = mkdtempSync(join(tmpdir(), "behold-978-pr-"));
    let reads = 0;
    const app = new Hono();
    chantPrRoute(app, () => dir, { now: () => { reads++; return new Date(0); } });
    for (const pin of ["pull-7", "pull-07", "pull-0007"]) expect((await app.request(`/api/chant/pr?pin=${pin}`)).status).toBe(200);
    for (const junk of ["a", "b", "c"]) await app.request(`/api/chant/pr?pin=${junk}`);
    expect(reads).toBe(2);
    vi.setSystemTime(CHANT_PR_READ_TTL_MS);
    await app.request("/api/chant/pr?pin=pull-7");
    expect(reads).toBe(3);
  });
});

describe("the composed feed's commit (behold#978)", () => {
  it("is a sha, or nothing; anything else is refused before it keys a read", async () => {
    expect(composedCommit(null)).toBeNull();
    expect(composedCommit("")).toBeNull();
    expect(composedCommit("abcdef1")).toBe("abcdef1");
    expect(composedCommit("a".repeat(40))).toBe("a".repeat(40));
    for (const bad of ["abc", "ABCDEF1", "a".repeat(41), "../x", "abcdefg"]) expect(composedCommit(bad)).toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), "behold-978-feed-"));
    const app = new Hono();
    chantComposedFeedRoutes(app, () => dir, { reportSource: () => { throw new Error("no loop here, so never read"); } });
    app.get("/api/terragucci/progress", (c) => c.json({ fell: "through" }));
    const bad = await app.request("/api/terragucci/progress?commit=nope");
    expect(bad.status).toBe(400);
    expect(await (await app.request("/api/terragucci/progress?commit=abcdef1")).json()).toEqual({ fell: "through" });
  });
});

describe("a public view ignores fresh (behold#978)", () => {
  it("takes fresh off the request and keeps the rest", () => {
    const signal = new AbortController().signal;
    const req = new Request("http://localhost/api/terragucci?fresh=1&repo=demo", { headers: { "x-a": "b" }, signal });
    const bare = withoutFresh(req)!;
    expect(new URL(bare.url).search).toBe("?repo=demo");
    expect(bare.headers.get("x-a")).toBe("b");
    expect(withoutFresh(new Request("http://localhost/api/terragucci?repo=demo"))).toBeUndefined();
  });

  it("no route of a public view sees fresh", async () => {
    const app = new Hono();
    publicRoutes(app, tmpdir());
    app.get("/api/terragucci/lifecycle", (c) => c.json({ fresh: new URL(c.req.url).searchParams.get("fresh"), query: c.req.query("fresh") ?? null, repo: c.req.query("repo") }));
    const seen = await (await app.request("/api/terragucci/lifecycle?fresh=1&repo=demo")).json();
    expect(seen).toEqual({ fresh: null, query: null, repo: "demo" });
  });
});
