import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { indexProbe, lifecycleKey, TerragucciPoller, terragucciLaneRoutes, type PollEvent, type Probe } from "./terragucci-poll.ts";
import type { LifecycleAnswer } from "./terragucci-lifecycle.ts";

// #505: the poll's conditional read of index.json, the push of a changed
// lifecycle read, and the timer stopping when no page is connected.

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const answer = (sha: string, at = "2026-10-10T00:00:00.000Z"): LifecycleAnswer => ({
  branch: "chant/lifecycle",
  found: true,
  via: "fetch",
  fetch: { ok: true },
  commit: { sha, committed: "2026-10-09T10:00:00Z" },
  read: { at },
  gates: [],
  locks: [],
  note: `read at ${at}`,
});

describe("indexProbe: index.json, asked conditionally (#505)", () => {
  it("sends If-None-Match with the ETag it last saw, and reads a 304 as unchanged", async () => {
    const seen: (string | undefined)[] = [];
    const etags = ['"a"', null, '"b"'];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const inm = (init?.headers as Record<string, string>)["if-none-match"];
      seen.push(inm);
      const next = etags.shift();
      return next === null ? new Response(null, { status: 304 }) : new Response("{}", { status: 200, headers: { etag: next! } });
    });
    const probe = indexProbe("https://reports.example.com/prefix/", { fetch: fetchFn as never });
    const first = await probe(undefined);
    expect(first).toEqual({ tag: '"a"', changed: false });
    expect(await probe(first.tag)).toEqual({ tag: '"a"', changed: false });
    expect(await probe('"a"')).toEqual({ tag: '"b"', changed: true });
    expect(seen).toEqual([undefined, '"a"', '"a"']);
    expect(fetchFn.mock.calls[0]![0]).toBe("https://reports.example.com/prefix/index.json");
  });

  it("asks S3 through the aws CLI with --if-none-match, and reads its 304 as unchanged", async () => {
    const calls: string[][] = [];
    const answers = [
      { code: 0, stdout: JSON.stringify({ ETag: '"e1"' }), stderr: "" },
      { code: 254, stdout: "", stderr: "An error occurred (304) when calling the HeadObject operation: Not Modified" },
      { code: 0, stdout: JSON.stringify({ ETag: '"e2"' }), stderr: "" },
    ];
    const probe = indexProbe("s3://bucket/pre/fix", { aws: async (args) => (calls.push(args), answers.shift()!) });
    const a = await probe(undefined);
    expect(await probe(a.tag)).toEqual({ tag: '"e1"', changed: false });
    expect(await probe('"e1"')).toEqual({ tag: '"e2"', changed: true });
    expect(calls[0]).toEqual(["s3api", "head-object", "--bucket", "bucket", "--key", "pre/fix/index.json", "--output", "json"]);
    expect(calls[1]).toEqual(["s3api", "head-object", "--bucket", "bucket", "--key", "pre/fix/index.json", "--if-none-match", '"e1"', "--output", "json"]);
  });

  it("signs a conditional HEAD itself when the environment holds credentials", async () => {
    const sent: { method: string; headers: Record<string, string> }[] = [];
    const fetchFn = async (_url: string, init: { method: string; headers: Record<string, string> }) => {
      sent.push(init);
      return init.headers["if-none-match"] ? { ok: false, status: 304, text: async () => "", headers: new Headers() } : { ok: true, status: 200, text: async () => "", headers: new Headers({ etag: '"s1"' }) };
    };
    const probe = indexProbe("s3://bucket/p", { fetch: fetchFn as never, env: { AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "s", AWS_REGION: "us-east-1" } });
    expect(await probe(undefined)).toEqual({ tag: '"s1"', changed: false });
    expect(await probe('"s1"')).toEqual({ tag: '"s1"', changed: false });
    expect(sent.map((s) => s.method)).toEqual(["HEAD", "HEAD"]);
    expect(sent[1]!.headers["if-none-match"]).toBe('"s1"');
    expect(sent[1]!.headers.authorization).toContain("if-none-match");
  });

  it("compares a directory source's index.json by mtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "behold-poll-test-"));
    made.push(dir);
    writeFileSync(join(dir, "index.json"), "{}");
    utimesSync(join(dir, "index.json"), 1_000, 1_000);
    const probe = indexProbe(dir);
    const a = await probe(undefined);
    expect(await probe(a.tag)).toEqual({ tag: a.tag, changed: false });
    utimesSync(join(dir, "index.json"), 2_000, 2_000);
    expect((await probe(a.tag)).changed).toBe(true);
  });
});

describe("TerragucciPoller (#505)", () => {
  function poller(o: { probe?: Probe; reads?: LifecycleAnswer[]; last?: LifecycleAnswer } = {}) {
    const reads = o.reads ?? [answer("aaa")];
    let i = 0;
    const lifecycle = vi.fn(async () => reads[Math.min(i++, reads.length - 1)]!);
    const probe = vi.fn(o.probe ?? (async () => ({ tag: "t1", changed: false })));
    const forget = vi.fn();
    const p = new TerragucciPoller({ intervalMs: 20, probe, lifecycle, onReportsChanged: forget, lastLifecycle: () => o.last, now: () => new Date("2026-10-10T00:00:00Z") });
    return { p, lifecycle, probe, forget };
  }

  it("pushes a lifecycle read that differs from the one the page loaded, and not one that does not", async () => {
    const { p } = poller({ reads: [answer("aaa", "2026-10-10T00:00:01Z"), answer("aaa", "2026-10-10T00:00:02Z"), answer("bbb")], last: answer("aaa") });
    const events: PollEvent[] = [];
    const off = p.subscribe((e) => events.push(e));
    await vi.waitFor(() => expect(events.filter((e) => e.type === "polled").length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    off();
    const pushed = events.filter((e) => e.type === "lifecycle").map((e) => (e.data as LifecycleAnswer).commit!.sha);
    expect(pushed).toEqual(["bbb"]);
  });

  it("pushes a reports event when index.json changed, and drops the reports cache", async () => {
    const tags = ["t1", "t1", "t2"];
    const { p, forget } = poller({ probe: async (prev) => { const tag = tags.shift() ?? "t2"; return { tag, changed: prev !== undefined && prev !== tag }; } });
    const events: PollEvent[] = [];
    const off = p.subscribe((e) => events.push(e));
    await vi.waitFor(() => expect(events.some((e) => e.type === "reports")).toBe(true), { timeout: 2000 });
    off();
    expect(events.find((e) => e.type === "reports")!.data).toMatchObject({ tag: "t2" });
    expect(forget).toHaveBeenCalledTimes(1);
    const polled = events.find((e) => e.type === "polled")!.data as { at: string; reports: { tag: string } };
    expect(polled.at).toBe("2026-10-10T00:00:00.000Z");
  });

  it("runs only while a page is subscribed, and stops when the last one leaves", async () => {
    const { p, probe, lifecycle } = poller();
    await new Promise((r) => setTimeout(r, 60));
    expect(probe).not.toHaveBeenCalled();
    const off1 = p.subscribe(() => {});
    const off2 = p.subscribe(() => {});
    await vi.waitFor(() => expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    off1();
    expect(p.active).toBe(true);
    off2();
    expect(p.active).toBe(false);
    await p.settled();
    const calls = probe.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(probe.mock.calls.length).toBe(calls);
    expect(lifecycle.mock.calls.length).toBe(calls);
  });

  it("says a failed probe in the polled event and still reads the lane", async () => {
    const { p } = poller({ probe: async () => { throw new Error("aws s3api head-object failed: AccessDenied"); } });
    const events: PollEvent[] = [];
    p.subscribe((e) => events.push(e));
    await p.tick();
    const polled = events.find((e) => e.type === "polled")!.data as { reports: { error?: string }; lifecycle: { commit?: string } };
    expect(polled.reports.error).toContain("AccessDenied");
    expect(polled.lifecycle.commit).toBe("aaa");
  });

  it("keys a lifecycle read by everything but when it was read", () => {
    expect(lifecycleKey(answer("a", "2026-01-01T00:00:00Z"))).toBe(lifecycleKey(answer("a", "2026-02-01T00:00:00Z")));
    expect(lifecycleKey(answer("a"))).not.toBe(lifecycleKey(answer("b")));
  });
});

describe("GET /api/terragucci/events (#505)", () => {
  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, re: RegExp): Promise<string> {
    let text = "";
    const dec = new TextDecoder();
    while (!re.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    return text;
  }

  function lane(pollSecs: number, reads: LifecycleAnswer[]) {
    const app = new Hono();
    let i = 0;
    const lifecycle = vi.fn();
    const probe = vi.fn(async () => ({ tag: "t", changed: false }));
    const poller = terragucciLaneRoutes(
      app,
      { source: "unused", pollSecs, probe, readLane: async () => (lifecycle(), reads[Math.min(i++, reads.length - 1)]!) },
      () => "/nowhere",
      () => {},
    );
    return { app, poller, probe, lifecycle };
  }

  it("streams a changed read to the page, and the poll stops when the page goes", async () => {
    const { app, poller, probe } = lane(0.02, [answer("aaa"), answer("bbb")]);
    const res = await app.request("/api/terragucci/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const text = await readUntil(reader, /event: lifecycle\ndata: [^\n]*"bbb"/);
    expect(text).toContain('event: hello\ndata: {"pollSecs":0.02}');
    expect(text).toMatch(/event: lifecycle\ndata: [^\n]*"aaa"/);
    expect(text).toMatch(/event: polled\n/);
    expect(poller.active).toBe(true);
    await reader.cancel();
    await vi.waitFor(() => expect(poller.active).toBe(false), { timeout: 2000 });
    await poller.settled();
    const calls = probe.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(probe.mock.calls.length).toBe(calls);
  });

  it("with --terragucci-poll 0 says so and never polls", async () => {
    const { app, poller, probe } = lane(0, [answer("aaa")]);
    const res = await app.request("/api/terragucci/events");
    const reader = res.body!.getReader();
    const text = await readUntil(reader, /event: ping/);
    expect(text).toContain('{"pollSecs":0}');
    expect(poller.active).toBe(false);
    await reader.cancel();
    expect(probe).not.toHaveBeenCalled();
  });
});
