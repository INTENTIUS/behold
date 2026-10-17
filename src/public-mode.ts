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
 * - Every GET that runs a command or calls out with the starter's
 *   credentials, and isn't what the public view shows, is refused with 403
 *   ({@link publicReadRefusal}).
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

/**
 * GET routes a public view refuses with 403, and why. Each one runs a command
 * or calls out with the process's own credentials (a cloud account's live
 * read, a plan, the forge login, the durable runtime), or reads something the
 * public view doesn't show. What a public view keeps: the terragucci reads
 * (`/api/terragucci*`, its timeline, progress and lifecycle, whose git fetch
 * of chant/lifecycle is how a waiting wave is shown), the gate history and
 * releases off the same branch, the source graph, the project summary, the
 * SSE stream, the lanes and the static page.
 */
const REFUSED_READS: Array<[RegExp, string]> = [
  [/^\/api\/ops\/[^/]+\/status$/, "the op tools are off"],
  [/^\/api\/operator(\/|$)/, "the op tools are off"],
  [/^\/api\/overlay$/, "it reads the live estate with behold's own credentials"],
  [/^\/api\/reconcile$/, "it plans against the live estate with behold's own credentials"],
  [/^\/api\/diff(\/|$)/, "it reads the live estate with behold's own credentials"],
  [/^\/api\/components\/compare$/, "it reads the live estate with behold's own credentials"],
  [/^\/api\/resources$/, "it runs chant against the project"],
  [/^\/api\/ci(\/|$)/, "it reads the pipeline and the forge run"],
  [/^\/api\/doctor$/, "it probes this machine's tools"],
  [/^\/api\/substrates$/, "it probes this machine's tools"],
  [/^\/api\/history$/, "it runs git against the checkout"],
  [/^\/api\/workspace\/(gates|why|lane|change-set)$/, "it runs chant against the workspace"],
  [/^\/api\/choudoufu\/(moves|split)$/, "it runs choudoufu"],
  [/^\/choudoufu\/(morph|split)$/, "it runs choudoufu"],
  [/^\/api\/sql-yodeler\/lifecycle$/, "a public view shows a terragucci repo"],
];

/** Query parameters that turn a source-graph read into a live one, or re-point it. */
const LIVE_PARAMS = ["env", "target", "consistent", "plan", "live"];

/** Why a public view refuses this GET, or undefined when it answers it. */
export function publicReadRefusal(path: string, query: URLSearchParams): string | undefined {
  for (const [re, why] of REFUSED_READS) if (re.test(path)) return why;
  if (path === "/api/graph" && LIVE_PARAMS.some((p) => query.has(p))) {
    return "a public view draws the source graph only; a live read uses behold's own credentials";
  }
  return undefined;
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
 * they run before everything else: the reads above are refused, and the
 * page is served with the public flag.
 */
export function publicRoutes(app: Hono, webRoot: string): void {
  app.use("*", async (c, next) => {
    const why = publicReadRefusal(c.req.path, new URL(c.req.url).searchParams);
    if (why) return c.json({ error: `behold is serving a public, read-only view: ${c.req.path} is refused, because ${why}`, code: "public" }, 403);
    await next();
  });
  const page = (): Response =>
    new Response(publicPage(webRoot), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  app.get("/", () => page());
  app.get("/index.html", () => page());
}
