/**
 * The chant compose demo's feed: the kiosk's ask mode reads `/api/terragucci` and `/api/terragucci/progress`, and for a
 * served checkout that runs chant's pull-request loop (src/chant-pr.ts `prLoopOf`) these two answer from chant's own
 * pr-report/v1 documents, in the bucket the pipeline's `--report-url` writes:
 *
 *   <report url>/<pull request>/<commit>/pr-plan.json        the plan, on the pull request's head
 *   <report url>/<pull request>/<commit>/pr-apply.json       the apply, on the merge commit
 *
 * The report URL is the pipeline's own (the workflow file's `--report-url`, with `${{ github.repository }}` filled from
 * the checkout's origin), or `serve --chant-report-url` over it. A served checkout that is not such a repo, or whose
 * bucket holds no composed run, goes on to the terragucci read as before (`next()`), so the choudoufu, Terragrunt and
 * Atmos demos are untouched. Register these before the terragucci routes.
 *
 * Which run: the newest pull request's. A `commit` (the progress read's pin, demo.json's) picks the pull request that
 * has a stage on that commit. Within it, the plan is the newest plan and the apply the newest apply.
 */
import type { Context, Hono } from "hono";
import { composedReportOf, composedView, type ComposedReport, type ComposedView } from "./chant-compose.ts";
import { prLoopOf } from "./chant-pr.ts";
import { realAws, type AwsRun, type TerragucciSource } from "./terragucci-source.ts";

const sameSha = (a: string, b: string): boolean => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
const name = (p: string): string => p.replace(/\/+$/, "").split("/").pop() ?? "";

export interface ComposedFeedDeps {
  /** serve's `--chant-report-url`, over the pipeline's. */
  reportUrl?: string;
  /** The source a report URL is read through. */
  reportSource: (url: string) => TerragucciSource;
  /** Component -> its dependencies, from the components graph, for the edge between stacks no report read marks. */
  dependsOn?: (dir: string) => Record<string, readonly string[]> | undefined;
  /** Runs `aws cloudformation describe-stacks`, to read the outputs of the stacks an apply finished. */
  aws?: AwsRun;
  now?: () => number;
}

interface Stage {
  report: ComposedReport;
  modified: string | null;
}

/** The newest plan and apply of one pull request, or of the pull request that holds `commit`. */
export async function readComposedStages(src: TerragucciSource, commit: string | null): Promise<{ plan?: Stage; apply?: Stage } | null> {
  if (!src.list) return null;
  const list = src.list.bind(src);
  const top = await list("", 500);
  const prs = top.prefixes.map(name).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a));
  const found: { plan?: Stage; apply?: Stage } = {};
  for (const pr of prs) {
    const shas = (await list(pr, 200)).prefixes.map(name);
    if (commit && !shas.some((s) => sameSha(s, commit))) continue;
    await Promise.all(
      shas.map(async (sha) => {
        const l = await list(`${pr}/${sha}`, 50);
        for (const stage of ["plan", "apply"] as const) {
          const file = `pr-${stage}.json`;
          const obj = l.objects.find((o) => o.key.endsWith(`/${file}`) || o.key === file);
          if (!obj) continue;
          if (found[stage] && (found[stage]!.modified ?? "") >= (obj.modified ?? "")) continue;
          const text = await src.read(`${pr}/${sha}/${file}`).catch(() => undefined);
          if (!text) continue;
          let doc: unknown;
          try {
            doc = JSON.parse(text);
          } catch {
            continue;
          }
          const report = composedReportOf(doc);
          if (report && (!found[stage] || (found[stage]!.modified ?? "") < (obj.modified ?? ""))) found[stage] = { report, modified: obj.modified };
        }
      }),
    );
    if (found.plan || found.apply) return found;
  }
  return null;
}

/** The outputs of the stacks an apply finished, by stack name. Empty for any stack that cannot be read. */
export async function stackOutputs(aws: AwsRun, stacks: readonly string[]): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  await Promise.all(
    stacks.map(async (stack) => {
      try {
        const r = await aws(["cloudformation", "describe-stacks", "--stack-name", stack, "--output", "json"]);
        if (r.code !== 0) return;
        const doc = JSON.parse(r.stdout) as { Stacks?: { Outputs?: { OutputKey?: string; OutputValue?: string }[] }[] };
        const o: Record<string, string> = {};
        for (const x of doc.Stacks?.[0]?.Outputs ?? []) if (x.OutputKey && typeof x.OutputValue === "string") o[x.OutputKey] = x.OutputValue;
        out[stack] = o;
      } catch {
        /* the stack is gone (the demo resets it) or aws is not reachable: the card says "filled from" instead */
      }
    }),
  );
  return out;
}

/** behold#978: how long one read of the composed run is shared. */
export const COMPOSED_READ_TTL_MS = 1_500;

/** behold#978: the `commit` a read asks for: a lowercase sha of 7 to 40 hex digits, null for none, undefined when refused. */
export function composedCommit(raw: string | null): string | null | undefined {
  if (raw === null || raw === "") return null;
  return /^[0-9a-f]{7,40}$/.test(raw) ? raw : undefined;
}

export function chantComposedFeedRoutes(app: Hono, dir: () => string, deps: ComposedFeedDeps): void {
  const aws = deps.aws ?? realAws;
  const now = deps.now ?? Date.now;
  const reads = new Map<string, { at: number; read: Promise<ComposedView | null> }>();
  // An output read once for an apply stays: the demo resets its stacks after the cycle, and the value was true then.
  const seen = new Map<string, Record<string, Record<string, string>>>();

  const view = (d: string, commit: string | null): Promise<ComposedView | null> => {
    const key = `${d}|${commit ?? ""}`;
    const t = now();
    const hit = reads.get(key);
    if (hit && t - hit.at < COMPOSED_READ_TTL_MS) return hit.read;
    // behold#978: every expired read goes when a new one is made, as terragucci-runs.ts does.
    for (const [k, v] of reads) if (t - v.at >= COMPOSED_READ_TTL_MS) reads.delete(k);
    const read = (async () => {
      const loop = prLoopOf(d);
      const url = deps.reportUrl ?? loop?.reportUrl;
      if (!loop || !url) return null;
      const stages = await readComposedStages(deps.reportSource(url), commit);
      if (!stages) return null;
      const plan = stages.plan?.report;
      const apply = stages.apply?.report;
      let outputs: Record<string, Record<string, string>> | undefined;
      if (apply) {
        const k = `${url}|${apply.pr}|${apply.head}`;
        outputs = seen.get(k);
        const want = [...new Set(apply.members.flatMap((m) => m.unknownInputs).map((r) => r.split(".")[0]!).filter(Boolean))];
        if (!outputs && want.length && apply.members.filter((m) => m.status === "applied").length) {
          const got = await stackOutputs(aws, want);
          if (want.every((w) => got[w] && Object.keys(got[w]!).length)) seen.set(k, (outputs = got));
          else outputs = got;
        }
      }
      const needs = deps.dependsOn?.(d);
      return composedView(plan, apply, {
        ...(stages.plan?.modified ? { planAt: stages.plan.modified } : {}),
        ...(stages.apply?.modified ? { applyAt: stages.apply.modified } : {}),
        ...(needs ? { dependsOn: needs } : {}),
        ...(outputs ? { outputs } : {}),
      });
    })().catch(() => null);
    reads.set(key, { at: t, read });
    return read;
  };

  // behold#978: `commit` is a sha or nothing; anything else is refused before it keys a read.
  const commitOf = (c: Context): { ok: true; commit: string | null } | { ok: false; refused: Response } => {
    const commit = composedCommit(new URL(c.req.url).searchParams.get("commit"));
    return commit === undefined ? { ok: false, refused: c.json({ error: "commit is a commit sha, 7 to 40 hex digits", code: "terragucci-progress" }, 400) } : { ok: true, commit };
  };
  app.get("/api/terragucci", async (c: Context, next) => {
    const asked = commitOf(c);
    if (!asked.ok) return asked.refused;
    const v = await view(dir(), asked.commit);
    if (!v) return next();
    return c.json(v.answer, 200, { "cache-control": "no-store" });
  });
  app.get("/api/terragucci/progress", async (c: Context, next) => {
    const asked = commitOf(c);
    if (!asked.ok) return asked.refused;
    const v = await view(dir(), asked.commit);
    if (!v) return next();
    return c.json(v.progress ?? { run: null, states: [], reads: [], waves: [], cards: {}, unmatched: [], watching: false }, 200, { "cache-control": "no-store" });
  });
}
