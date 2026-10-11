/**
 * #505: while a page is open, behold asks whether terragucci's reports or the
 * repo's `chant/lifecycle` branch moved, and tells the page over SSE.
 *
 * - The reports: one conditional request for `index.json` per tick. An S3 or
 *   http source is asked with `If-None-Match: <the ETag last seen>` (a 304
 *   costs no body); a directory source compares the file's mtime. A changed
 *   index is pushed as a `reports` event and the page reads the marks again.
 * - The lane: `chant/lifecycle` is fetched again on the same timer
 *   (src/terragucci-lifecycle.ts). A read whose tip, source or entries
 *   differ from the last one is pushed whole as a `lifecycle` event.
 * - Every tick ends with a `polled` event carrying when it read, so the page
 *   says when it last looked rather than painting anything as live.
 *
 * The timer runs only while at least one page holds `/api/terragucci/events`
 * open: the first subscriber starts it, the last one leaving stops it, and a
 * tick never overlaps the one before. `--terragucci-poll 0` turns it off.
 *
 * Nothing here writes: the routes are GETs, and the only directory behold
 * writes to is its own lifecycle cache, outside the checkout.
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { hasEnvCredentials, S3Object, s3FromEnv } from "./s3-object.ts";
import { realAws, type AwsRun } from "./terragucci-source.ts";
import { readLifecycle, type LifecycleAnswer, type LifecycleOptions } from "./terragucci-lifecycle.ts";

/** The default tick, the same 30 s the reports read is cached for. */
export const TERRAGUCCI_POLL_SECS = 30;
const INDEX = "index.json";

/** What the index looked like this time: a tag to compare (ETag or mtime), or undefined when there is no index. */
export interface IndexProbe {
  tag?: string;
  /** True when the tag differs from the one asked with. The first probe of a poll has nothing to differ from. */
  changed: boolean;
}

export type Probe = (prev: string | undefined) => Promise<IndexProbe>;

const trim = (s: string): string => s.replace(/^\/+|\/+$/g, "");
const joinKey = (...p: string[]): string => p.map(trim).filter(Boolean).join("/");
const verdict = (prev: string | undefined, tag: string | undefined): IndexProbe => ({ ...(tag ? { tag } : {}), changed: prev !== undefined && tag !== prev });

/**
 * The conditional read of `index.json` for a `--terragucci` value: the same
 * three kinds of source src/terragucci-source.ts reads, asked only whether
 * the index changed.
 */
export function indexProbe(spec: string, opts: { cwd?: string; aws?: AwsRun; fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Probe {
  const s3 = /^s3:\/\/([^/]+)\/?(.*)$/.exec(spec);
  if (s3) {
    const bucket = s3[1]!;
    const key = joinKey(s3[2] ?? "", INDEX);
    const env = opts.env ?? process.env;
    if (!opts.aws && hasEnvCredentials(env)) {
      const client = new S3Object(s3FromEnv(bucket, env), opts.fetch as never);
      return async (prev) => {
        const h = await client.head(key, prev);
        if (!h) return verdict(prev, undefined);
        return h.same ? { tag: prev!, changed: false } : verdict(prev, h.etag);
      };
    }
    const aws = opts.aws ?? realAws;
    return async (prev) => {
      const r = await aws(["s3api", "head-object", "--bucket", bucket, "--key", key, ...(prev ? ["--if-none-match", prev] : []), "--output", "json"]);
      if (r.code === 0) {
        let etag: string | undefined;
        try {
          etag = (JSON.parse(r.stdout) as { ETag?: string }).ETag;
        } catch {
          etag = undefined;
        }
        return verdict(prev, etag);
      }
      if (/\(304\)|Not Modified/i.test(r.stderr)) return { tag: prev!, changed: false };
      if (/\(404\)|Not Found|NoSuchKey/i.test(r.stderr)) return verdict(prev, undefined);
      throw new Error(`aws s3api head-object s3://${bucket}/${key} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    };
  }
  if (/^https?:\/\//.test(spec)) {
    const url = `${spec.replace(/\/+$/, "")}/${INDEX}`;
    const get = opts.fetch ?? fetch;
    return async (prev) => {
      const res = await get(url, { headers: prev ? { "if-none-match": prev } : {} });
      if (res.status === 304) return { tag: prev!, changed: false };
      if (res.status === 404 || res.status === 403) return verdict(prev, undefined);
      if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
      // A server that sends no ETag is compared by the body's digest.
      const etag = res.headers.get("etag") ?? `sha256:${createHash("sha256").update(await res.text()).digest("hex")}`;
      return verdict(prev, etag);
    };
  }
  const file = join(resolve(opts.cwd ?? process.cwd(), spec), INDEX);
  return async (prev) => {
    try {
      const s = await stat(file);
      return verdict(prev, `mtime:${s.mtimeMs}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return verdict(prev, undefined);
      throw e;
    }
  };
}

/** What makes two lifecycle reads the same picture: everything but when it was read. */
export function lifecycleKey(a: LifecycleAnswer): string {
  const { read: _read, note: _note, ...rest } = a;
  return JSON.stringify(rest);
}

export type PollEvent =
  | { type: "reports"; data: { at: string; tag?: string } }
  | { type: "lifecycle"; data: LifecycleAnswer }
  | { type: "polled"; data: { at: string; reports: { tag?: string; error?: string }; lifecycle: { commit?: string; via?: string; error?: string } } };

export interface PollerOptions {
  intervalMs: number;
  probe: Probe;
  /** A fresh lifecycle read; the poller hands it to `onLifecycle` too, so the GET route's cache keeps up. */
  lifecycle: () => Promise<LifecycleAnswer>;
  /** The last lifecycle read the route answered, so a page that just loaded is not pushed the same read again. */
  lastLifecycle?: () => LifecycleAnswer | undefined;
  onLifecycle?: (a: LifecycleAnswer) => void;
  onReportsChanged?: () => void;
  now?: () => Date;
}

/**
 * The timer behind `/api/terragucci/events`. Runs while it has subscribers;
 * each tick probes the index, reads the lane, and sends what changed.
 */
export class TerragucciPoller {
  private listeners = new Set<(e: PollEvent) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private indexTag: string | undefined;
  private lastKey: string | undefined;
  /** Bumped on every start and stop, so a tick that outlives a stop schedules nothing. */
  private generation = 0;

  constructor(private readonly o: PollerOptions) {}

  get active(): boolean {
    return this.listeners.size > 0;
  }

  subscribe(fn: (e: PollEvent) => void): () => void {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.start();
    return () => {
      if (!this.listeners.delete(fn)) return;
      if (this.listeners.size === 0) this.stop();
    };
  }

  private start(): void {
    this.generation++;
    this.indexTag = undefined;
    const last = this.o.lastLifecycle?.();
    this.lastKey = last ? lifecycleKey(last) : undefined;
    // The first tick sets the index's baseline at once; a change after the page loaded is caught from the next.
    this.schedule(0);
  }

  private stop(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    const gen = this.generation;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (gen !== this.generation) return;
      this.running = this.tick().finally(() => {
        this.running = undefined;
        if (gen === this.generation && this.active) this.schedule(this.o.intervalMs);
      });
    }, ms);
  }

  private send(e: PollEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }

  /** One round: the index, then the lane. Exposed for a test; the timer calls it. */
  async tick(): Promise<void> {
    const now = () => (this.o.now ?? (() => new Date()))().toISOString();
    const reports: { tag?: string; error?: string } = {};
    try {
      const p = await this.o.probe(this.indexTag);
      if (p.tag) reports.tag = p.tag;
      if (p.changed) {
        this.o.onReportsChanged?.();
        this.send({ type: "reports", data: { at: now(), ...(p.tag ? { tag: p.tag } : {}) } });
      }
      this.indexTag = p.tag;
    } catch (e) {
      reports.error = e instanceof Error ? e.message : String(e);
    }
    const lifecycle: { commit?: string; via?: string; error?: string } = {};
    try {
      const a = await this.o.lifecycle();
      this.o.onLifecycle?.(a);
      if (a.commit) lifecycle.commit = a.commit.sha;
      lifecycle.via = a.via;
      const key = lifecycleKey(a);
      if (key !== this.lastKey) {
        this.lastKey = key;
        this.send({ type: "lifecycle", data: a });
      }
    } catch (e) {
      lifecycle.error = e instanceof Error ? e.message : String(e);
    }
    this.send({ type: "polled", data: { at: now(), reports, lifecycle } });
  }

  /** For a test: wait for a tick in flight. */
  async settled(): Promise<void> {
    await this.running;
  }
}

export interface LaneRouteOptions {
  source: string;
  /** Seconds between ticks; 0 turns the poll off. */
  pollSecs?: number;
  aws?: AwsRun;
  fetch?: typeof fetch;
  now?: () => Date;
  lifecycle?: LifecycleOptions;
  /** Injected by a test instead of the real probe. */
  probe?: Probe;
  /** Injected by a test instead of readLifecycle. */
  readLane?: (base: string) => Promise<LifecycleAnswer>;
}

/** How long a lifecycle read is reused by the GET route, as the reports read is. */
export const LIFECYCLE_READ_TTL_MS = 30_000;

/**
 * `GET /api/terragucci/lifecycle` and `GET /api/terragucci/events`. `base()`
 * names the checkout per request (a project switch changes it); `forget()`
 * drops the reports read's cache when the index changed.
 */
export function terragucciLaneRoutes(app: Hono, o: LaneRouteOptions, base: () => string, forget: () => void): TerragucciPoller {
  let cached: { at: number; base: string; read: Promise<LifecycleAnswer> } | undefined;
  let last: LifecycleAnswer | undefined;
  const fresh = (): Promise<LifecycleAnswer> => {
    const b = base();
    const p = o.readLane ? o.readLane(b) : readLifecycle(b, { ...(o.now ? { now: o.now } : {}), ...o.lifecycle });
    cached = { at: Date.now(), base: b, read: p };
    p.then((a) => (last = a)).catch(() => (cached = undefined));
    return p;
  };
  const read = (force: boolean): Promise<LifecycleAnswer> => {
    const b = base();
    if (!force && cached && cached.base === b && Date.now() - cached.at < LIFECYCLE_READ_TTL_MS) return cached.read;
    return fresh();
  };

  const pollSecs = o.pollSecs ?? TERRAGUCCI_POLL_SECS;
  const poller = new TerragucciPoller({
    intervalMs: pollSecs * 1000,
    probe: o.probe ?? indexProbe(o.source, { ...(o.aws ? { aws: o.aws } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) }),
    lifecycle: fresh,
    lastLifecycle: () => last,
    onReportsChanged: forget,
    ...(o.now ? { now: o.now } : {}),
  });

  app.get("/api/terragucci/lifecycle", async (c) => c.json(await read(new URL(c.req.url).searchParams.get("fresh") === "1")));

  app.get("/api/terragucci/events", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ pollSecs }) });
      const unsubscribe = pollSecs > 0 ? poller.subscribe((e) => void stream.writeSSE({ event: e.type, data: JSON.stringify(e.data) }).catch(() => undefined)) : () => {};
      stream.onAbort(unsubscribe);
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(30_000);
      }
      unsubscribe();
    }),
  );
  return poller;
}
