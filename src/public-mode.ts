/**
 * `behold serve --public` (#569): a read-only view anyone may load, for a
 * repo that a loop drives through its pipeline (terragucci#1014). Public is a
 * build mode, not a setting. Under it:
 *
 * - No OpRunner is ever constructed. The routes and the startup path get a
 *   {@link ReadOnlyRunner}: it reports an idle runner and starts nothing, so
 *   no code path left open by mistake can run a command with the starter's
 *   credentials.
 * - The request guard refuses every method but GET, HEAD and OPTIONS with 405
 *   (src/request-guard.ts), before any route sees the request.
 * - The op tools' reads, which ask the durable runtime about Ops and
 *   ConvergeOps with the starter's credentials, are refused with 403 (below).
 * - The page is served with `window.__BEHOLD_PUBLIC__`, and web/app.js hides
 *   every control that writes.
 *
 * behold still binds 127.0.0.1. The public host's proxy forwards the public
 * name in Host, and that name is passed with `--allow-host`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { OpRunner } from "./op-runner.ts";
import { initialApplyProgress, type ApplyProgressState } from "./apply.ts";
import { initialRunState, type RunState } from "./run-playhead.ts";
import { initialOperatorState, type OperatorState } from "./operator.ts";

/** The runner's public surface: what the routes and startup call. */
export type Runner = Pick<OpRunner, keyof OpRunner>;

/** The runner a public serve gets instead of an OpRunner: always idle, and
 * every method that would start something answers "not started". */
export class ReadOnlyRunner implements Runner {
  readonly running: string | null = null;
  readonly applyProgress: ApplyProgressState = initialApplyProgress;
  readonly runState: RunState = initialRunState;
  readonly operatorState: OperatorState = initialOperatorState;
  retarget(): void {}
  noteGate(): RunState {
    return initialRunState;
  }
  noteDeclaredConvergeOps(): OperatorState {
    return initialOperatorState;
  }
  noteOperator(): OperatorState {
    return initialOperatorState;
  }
  trigger(): boolean {
    return false;
  }
  run(): boolean {
    return false;
  }
  apply(): boolean {
    return false;
  }
  pipeline(): boolean {
    return false;
  }
  bringUp(): boolean {
    return false;
  }
  track(): boolean {
    return false;
  }
}

/** GET routes that are op tools: they shell chant against the durable runtime
 * with the starter's credentials. A public view answers none of them. */
const OP_TOOL_READS = [/^\/api\/ops\/[^/]+\/status$/, /^\/api\/operator(\/|$)/];

export function isOpToolRead(path: string): boolean {
  return OP_TOOL_READS.some((re) => re.test(path));
}

/** The flag the page reads to hide every control that writes. */
export const PUBLIC_FLAG = "<script>window.__BEHOLD_PUBLIC__ = true;</script>";

/** index.html with the public flag in its head. */
export function publicPage(webRoot: string): string {
  const html = readFileSync(join(webRoot, "index.html"), "utf8");
  return html.replace("</head>", `  ${PUBLIC_FLAG}\n  </head>`);
}

/**
 * The public mode's own routes, registered right after the request guard so
 * they run before everything else: the op tools' reads are refused, and the
 * page is served with the public flag.
 */
export function publicRoutes(app: Hono, webRoot: string): void {
  app.use("*", async (c, next) => {
    if (isOpToolRead(c.req.path)) {
      return c.json({ error: "behold is serving a public, read-only view: the op tools are off", code: "public" }, 403);
    }
    await next();
  });
  const page = (): Response =>
    new Response(publicPage(webRoot), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  app.get("/", () => page());
  app.get("/index.html", () => page());
}
