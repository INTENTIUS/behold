/**
 * behold#1164: check the ask demo as the Worker serves it.
 *
 *   just ask-demo-check                         serve dist-ask-demo/ with `wrangler dev`, then check it
 *   just ask-demo-check --serve static          the same, on scripts/serve-static.mjs
 *   just ask-demo-check --url https://behold-ask-demo.intentius.workers.dev
 *                                               the deployed Worker, after a deploy
 *   npx tsx scripts/ask-demo/check.ts [<dir>] [--serve wrangler|static] [--url <url>] [--port <n>] [--pace <n>]
 *
 * Two parts, each printing a verdict line per check:
 *
 *  1. Files. GET the page and each file it needs (narration.json and the
 *     WebAssembly worker among them): each answers 200 with its type, and,
 *     when the bundle folder is at hand, the same bytes. The deploy config is
 *     not served, and every answer carries the bundle's content security
 *     policy (ASK_DEMO_CSP, from the bundle's `_headers`).
 *  2. The page. Headless Chrome (the shot launcher's) plays the first loop at
 *     `?pace`, waits for LadybugDB's WebAssembly build, then asks the loop's
 *     query again as a visitor would and reads the answer's rows. It fails on
 *     any request that leaves the page's origin, any same-origin request that
 *     does not answer 2xx, a page error, or a content security policy
 *     violation.
 *
 * Exits 0 when every line passed, 1 when one failed, 2 when it could not run.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchShotBrowser } from "../../src/shot.ts";
import { ASK_DEMO_CSP, DEFAULT_OUT, WRANGLER_VERSION } from "./bundle.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** What the page needs to play and to answer a visitor, with the type each must be served as. */
export const NEEDED: ReadonlyArray<{ path: string; type: RegExp }> = [
  { path: "", type: /^text\/html/ },
  { path: "narration.json", type: /json/ },
  { path: "estate.json", type: /json/ },
  { path: "graphdb.json", type: /json/ },
  { path: "ask-demo.js", type: /javascript/ },
  { path: "graph-db-wasm.js", type: /javascript/ },
  { path: "lbug-wasm.js", type: /javascript/ },
  { path: "lbug_wasm_worker.js", type: /javascript/ },
  { path: "graph.html", type: /^text\/html/ },
  { path: "graph-static.js", type: /javascript/ },
  { path: "graph-query.js", type: /javascript/ },
  { path: "engine-badge.js", type: /javascript/ },
  { path: "vendors/ladybugdb.png", type: /^image\/png/ },
];
/** In the bundle folder for the deploy, never served. */
export const NOT_SERVED = ["wrangler.jsonc", ".assetsignore", "_headers"] as const;

export interface Verdict {
  ok: boolean;
  line: string;
}
const pass = (line: string): Verdict => ({ ok: true, line });
const fail = (line: string): Verdict => ({ ok: false, line });
export const verdictText = (v: Verdict) => `${v.ok ? "ok  " : "FAIL"}  ${v.line}`;

const kib = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : `${(n / 1024).toFixed(1)} KiB`);

/** Requests that leave `origin`. data: and blob: URLs are made in the page, so they stay. */
export function outsideRequests(requests: readonly string[], origin: string): string[] {
  return requests.filter((r) => !r.startsWith("data:") && !r.startsWith("blob:") && new URL(r).origin !== origin);
}

/** The policy's directives as a map, to compare two policies whatever their order or spacing. */
export function cspDirectives(csp: string): Map<string, string> {
  return new Map(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...v]) => [name!.toLowerCase(), v.join(" ")]),
  );
}
export function sameCsp(a: string | null, b: string): boolean {
  if (!a) return false;
  const x = cspDirectives(a);
  const y = cspDirectives(b);
  return x.size === y.size && [...y].every(([k, v]) => x.get(k) === v);
}

/** GET each needed file from `base`; with `dir`, compare its bytes to the bundle's. */
export async function checkFiles(base: string, dir: string | null): Promise<Verdict[]> {
  const out: Verdict[] = [];
  let cspSeen = 0;
  for (const f of NEEDED) {
    const url = new URL(f.path, base).href;
    const name = f.path || "/";
    let res: Response;
    try {
      res = await fetch(url, { headers: { "accept-encoding": "identity" } });
    } catch (e) {
      out.push(fail(`GET ${name}: ${(e as Error).message}`));
      continue;
    }
    const body = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get("content-type") ?? "";
    if (res.status !== 200) {
      out.push(fail(`GET ${name} answered ${res.status}; the bundle is missing it`));
      continue;
    }
    if (!f.type.test(type)) {
      out.push(fail(`GET ${name} is served as "${type}", not ${f.type}`));
      continue;
    }
    if (dir) {
      const local = readFileSync(join(dir, f.path || "index.html"));
      if (!local.equals(body)) {
        out.push(fail(`GET ${name}: ${kib(body.length)} served, not the bundle's ${kib(local.length)}`));
        continue;
      }
    }
    if (sameCsp(res.headers.get("content-security-policy"), ASK_DEMO_CSP)) cspSeen++;
    out.push(pass(`GET ${name} 200 ${type.split(";")[0]} ${kib(body.length)}${dir ? ", the bundle's bytes" : ""}`));
  }
  for (const p of NOT_SERVED) {
    const res = await fetch(new URL(p, base)).catch(() => null);
    if (res) await res.arrayBuffer();
    out.push(res && res.status === 404 ? pass(`GET ${p} 404, not served`) : fail(`GET ${p} answered ${res ? res.status : "nothing"}; it should not be served`));
  }
  out.push(
    cspSeen === NEEDED.length
      ? pass(`every file carries the bundle's content security policy (${ASK_DEMO_CSP.split(";")[1]!.trim()}, and the rest)`)
      : fail(`${NEEDED.length - cspSeen} of ${NEEDED.length} files came without the bundle's content security policy; is _headers in the bundle?`),
  );
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;

interface Narration {
  turns: Array<{ id: string; kind: string; cypher?: string; rows: Array<Record<string, unknown>> }>;
}

const SEEN = `(() => { const d = document.documentElement.dataset; return { loop: d.loop || "", phase: d.phase || "", engine: d.engine || "", visitor: d.visitor || "", failed: d.failed || "", error: (document.getElementById("g-error") || {}).textContent || "", rows: (document.getElementById("g-rows") || {}).innerText || "", cypher: (document.getElementById("g-cypher") || {}).value || "" }; })()`;

async function until(page: Page, what: string, test: (s: Record<string, string>) => boolean, ms: number): Promise<Record<string, string>> {
  const end = Date.now() + ms;
  let last: Record<string, string> = {};
  // Polled with evaluate: waitForFunction compiles its predicate in the page, which the policy refuses.
  while (Date.now() < end) {
    last = await page.evaluate(SEEN);
    if (last.failed) throw new Error(`the page did not load its recording (${what})`);
    if (test(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waited ${Math.round(ms / 1000)} s for ${what}; the page showed ${JSON.stringify({ ...last, rows: last.rows?.slice(0, 200) })}`);
}

/** Play the first loop in headless Chrome, then ask its query as a visitor; every request is watched. */
export async function checkPage(base: string, narration: Narration, opts: { pace?: number } = {}): Promise<Verdict[]> {
  const out: Verdict[] = [];
  const launched = await launchShotBrowser();
  const browser = launched.browser as unknown as { newContext(o?: object): Promise<any>; close(): Promise<void> };
  const origin = new URL(base).origin;
  const requests: string[] = [];
  const bad: string[] = [];
  const errors: string[] = [];
  const violations: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    context.on("request", (r: { url(): string }) => requests.push(r.url()));
    context.on("requestfailed", (r: { url(): string; failure(): { errorText: string } | null }) => {
      if (r.url().startsWith(origin)) bad.push(`${new URL(r.url()).pathname} failed (${r.failure()?.errorText ?? "?"})`);
    });
    context.on("response", (r: { url(): string; status(): number }) => {
      const u = new URL(r.url());
      if (u.origin === origin && (r.status() < 200 || r.status() >= 400) && u.pathname !== "/favicon.ico") bad.push(`${u.pathname} answered ${r.status()}`);
    });
    const page = await context.newPage();
    page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("console", (m: { type(): string; text(): string }) => {
      if (/content security policy/i.test(m.text())) violations.push(m.text());
    });
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = seen;
      addEventListener("securitypolicyviolation", (e) => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const t0 = Date.now();
    const url = new URL(base);
    url.searchParams.set("pace", String(opts.pace ?? 8));
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    const q = narration.turns.find((t) => t.kind === "question");
    if (!q) throw new Error("narration.json has no question turn");

    const after = await until(page, "the first loop to finish", (s) => s.loop === "0" && s.phase === "after", 180_000);
    const recorded = q.rows.flatMap((r) => Object.values(r).map(String));
    const shown = recorded.filter((v) => after.rows.includes(v));
    out.push(
      after.cypher === q.cypher && shown.length === recorded.length
        ? pass(`the first loop played in ${((Date.now() - t0) / 1000).toFixed(1)} s at pace ${opts.pace ?? 8}: ${q.id}, its Cypher in the box and its ${q.rows.length} recorded row(s) drawn`)
        : fail(`the first loop finished without ${after.cypher === q.cypher ? `${recorded.length - shown.length} of its recorded values in the rows` : "its Cypher in the box"}`),
    );
    const ready = await until(page, "LadybugDB's WebAssembly build to load", (s) => s.engine === "ready" || s.engine === "failed", 180_000);
    if (ready.engine !== "ready") {
      const why: string = await page.evaluate(() => document.getElementById("g-engine")?.textContent ?? "");
      // The engine's worker inherits the policy, and a refusal there reaches the page only as this message.
      if (/content security policy/i.test(why)) violations.push(`in the engine's worker: ${why}`);
      out.push(fail(`LadybugDB's WebAssembly build did not load: ${why}`));
    } else {
      out.push(pass(`LadybugDB's WebAssembly build loaded in the page (${await page.evaluate(() => document.getElementById("g-engine")?.textContent ?? "")})`));
      await page.click("#g-ask");
      const asked = await until(page, "the visitor's query to answer", (s) => s.visitor === "1", 60_000);
      const got = recorded.filter((v) => asked.rows.includes(v));
      out.push(
        !asked.error && got.length === recorded.length
          ? pass(`a visitor's query ran in the page and answered the recorded rows (${q.rows.length})`)
          : fail(`a visitor's query answered ${asked.error ? `an error: ${asked.error}` : `without ${recorded.length - got.length} recorded value(s)`}`),
      );
    }
    violations.push(...((await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])) as string[]));
    await context.close();
  } catch (e) {
    out.push(fail((e as Error).message));
  } finally {
    await browser.close();
  }
  const outside = outsideRequests(requests, origin);
  const worker = requests.some((r) => r.startsWith(origin) && new URL(r).pathname.endsWith("/lbug_wasm_worker.js"));
  out.push(worker ? pass("the page loaded lbug_wasm_worker.js from the bundle") : fail("the page never asked for lbug_wasm_worker.js"));
  out.push(
    outside.length
      ? fail(`${outside.length} request(s) left the bundle's origin: ${[...new Set(outside)].slice(0, 5).join(", ")}`)
      : pass(`${requests.length} requests, none left ${origin}`),
  );
  out.push(bad.length ? fail(`${bad.length} request(s) to the bundle did not answer: ${[...new Set(bad)].slice(0, 5).join(", ")}`) : pass("every request to the bundle answered"));
  out.push(errors.length ? fail(`${errors.length} page error(s): ${errors.slice(0, 3).join(" | ")}`) : pass("no page errors"));
  out.push(violations.length ? fail(`${violations.length} content security policy violation(s): ${[...new Set(violations)].slice(0, 3).join(" | ")}`) : pass("no content security policy violations"));
  return out;
}

// --- Serving ---------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((ok, no) => {
    const s = createServer();
    s.once("error", no);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

async function waitUp(base: string, child: ChildProcess, log: () => string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`the server exited (${child.exitCode}) before it answered:\n${log().slice(-2000)}`);
    const r = await fetch(base).catch(() => null);
    if (r) {
      await r.arrayBuffer();
      return;
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`nothing answered on ${base} within ${ms / 1000} s:\n${log().slice(-2000)}`);
}

/** Serve `dir` the way the Worker will (`wrangler dev` on its wrangler.jsonc), or with the static server. */
export async function serveBundle(dir: string, how: "wrangler" | "static", port?: number): Promise<{ base: string; stop(): void }> {
  const p = port ?? (await freePort());
  const cmd =
    how === "wrangler"
      ? { bin: "npx", args: ["--yes", `wrangler@${WRANGLER_VERSION}`, "dev", "--ip", "127.0.0.1", "--port", String(p), "--show-interactive-dev-session=false"], cwd: dir }
      : { bin: process.execPath, args: [join(ROOT, "scripts", "serve-static.mjs"), dir, String(p)], cwd: ROOT };
  let log = "";
  const child = spawn(cmd.bin, cmd.args, { cwd: cmd.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  const stop = () => {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      /* gone */
    }
  };
  const base = `http://127.0.0.1:${p}/`;
  try {
    await waitUp(base, child, () => log, 120_000);
  } catch (e) {
    stop();
    throw e;
  }
  return { base, stop };
}

// --- The command -----------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flagged = new Set(["--serve", "--url", "--port", "--pace"].flatMap((f) => (argv.includes(f) ? [argv.indexOf(f), argv.indexOf(f) + 1] : [])));
  const positional = argv.find((a, i) => !a.startsWith("--") && !flagged.has(i));
  const url = arg("--url");
  const how = (arg("--serve") ?? "wrangler") as "wrangler" | "static";
  if (how !== "wrangler" && how !== "static") throw new Error(`--serve is wrangler or static, not ${how}`);
  const dirArg = positional ?? (url ? undefined : DEFAULT_OUT);
  const dir = dirArg ? resolve(dirArg) : null;
  if (dir && !existsSync(join(dir, "index.html"))) throw new Error(`${dir} holds no bundle; build it with \`just ask-demo-bundle\``);

  let served: { base: string; stop(): void } | null = null;
  let base: string;
  if (url) {
    base = new URL(url).href.replace(/\/?$/, "/");
  } else {
    process.stdout.write(`ask-demo check: serving ${dir} with ${how === "wrangler" ? `wrangler@${WRANGLER_VERSION} dev` : "scripts/serve-static.mjs"}\n`);
    served = await serveBundle(dir!, how, arg("--port") ? Number(arg("--port")) : undefined);
    base = served.base;
  }
  process.stdout.write(`ask-demo check: ${base}\n\n`);
  const verdicts: Verdict[] = [];
  const say = (vs: Verdict[]) => {
    for (const v of vs) process.stdout.write(`${verdictText(v)}\n`);
    verdicts.push(...vs);
  };
  try {
    say(await checkFiles(base, dir));
    const nres = await fetch(new URL("narration.json", base)).catch(() => null);
    if (!nres || !nres.ok) {
      say([fail("the page was not played: narration.json did not load")]);
    } else {
      say(await checkPage(base, (await nres.json()) as Narration, { pace: arg("--pace") ? Number(arg("--pace")) : undefined }));
    }
  } finally {
    served?.stop();
  }
  const failed = verdicts.filter((v) => !v.ok).length;
  process.stdout.write(`\nask-demo check: ${failed ? `FAIL, ${failed} of ${verdicts.length} checks failed` : `PASS, ${verdicts.length} checks`} against ${base}\n`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`ask-demo check: ${(e as Error).message}\n`);
      process.exit(2);
    },
  );
}
