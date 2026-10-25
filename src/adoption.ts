/**
 * behold#999: "adopt this root or stack". A stock member of a declared
 * workspace is offered adoption into its engine tier: what it gains, what it
 * does not, what gets claimed and what is refused or left out and why, and the
 * command. The start is always gated by the engine's own tool, and behold
 * never passes the flag that confirms it.
 *
 * The seam is the member's kind: {@link ADOPTERS} holds what one kind adopts
 * into. On this branch (integration/pulumi-engine) it holds the Pulumi half:
 * a stock Pulumi stack adopted into plunge with `plunge stack adopt`
 * (src/pulumi-adoption.ts says how, and why the start is the classification
 * and never the confirm). The Terraform half (a root into choudoufu with
 * `chant workspace promote --state`) was built on integration/choudoufu-engine
 * with these same names, `Adopter`, `ADOPTERS`, `ADOPTION_WAITS`,
 * `adopterFor` and `adoptionRoutes`, and the same four routes, and reaches
 * this branch with that path's merge: its `terraform` row then joins
 * {@link ADOPTERS}, the waiting line below goes, and each route keeps its
 * `pulumi` branch ahead of the terraform body.
 *
 * - `GET /api/adopt`: what each member is offered.
 * - `GET /api/adopt/report?member=<name>[&stack=<name>]`: the read-only
 *   classification, each resource with its fate.
 * - `POST /api/adopt/start` `{member, stack?}`: the same classification,
 *   started through the runner's `track`, answering the confirm command.
 * - `GET /api/adopt/runs/:id`: one started adoption.
 */
import type { Hono } from "hono";
import type { Broadcaster } from "./events.ts";
import type { Runner } from "./public-mode.ts";
import { classify, defaultSpawnPlunge, PULUMI_ADOPTER, pulumiOffer, pulumiPlanFor, pulumiReportOf, pulumiRunOf, type PulumiAdoptRun, type SpawnPlunge } from "./pulumi-adoption.ts";
import type { Workspace, WorkspaceMember } from "./workspace.ts";

/** How many started adoptions behold keeps in memory. */
export const ADOPT_RUNS_KEPT = 20;

const ID = /^adopt-[a-z0-9-]{1,40}$/;

/** What one member kind adopts into, and what that gives it. */
export interface Adopter {
  kind: string;
  /** The engine the member moves to. */
  engine: string;
  /** What the engine tier gives the member, plainly. */
  gains: string[];
  /** What it does not give, so the offer is not oversold. */
  limits: string[];
  /** How to get the state file the read needs. */
  state: string;
}

/** Member kinds that can be adopted, by kind. */
export const ADOPTERS: Readonly<Record<string, Adopter>> = { pulumi: PULUMI_ADOPTER };

/** Kinds whose adoption is planned and not built yet, and what it waits on. */
export const ADOPTION_WAITS: Readonly<Record<string, string>> = {
  terraform: "Adopting a Terraform root into choudoufu is built on behold's integration/choudoufu-engine (behold#999) and is not on this build yet.",
};

export function adopterFor(kind: string): Adopter | undefined {
  return Object.prototype.hasOwnProperty.call(ADOPTERS, kind) ? ADOPTERS[kind] : undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export interface AdoptionOptions {
  workspace: () => Workspace | undefined;
  runner: Runner;
  broadcaster: Broadcaster;
  preview?: () => boolean;
  /** Starts plunge for a pulumi member's classification. Tests pass their own. */
  spawnPlunge?: SpawnPlunge;
  /** The environment plunge is started from (PULUMI_SKIP_CONFIRMATIONS is always dropped). */
  env?: () => NodeJS.ProcessEnv;
  now?: () => Date;
}

type Refusal = { error: string; code: string; remedy?: string };

/** The routes (see the module comment). */
export function adoptionRoutes(app: Hono, opts: AdoptionOptions): void {
  const pulumiRuns: PulumiAdoptRun[] = [];
  const spawnPlunge = opts.spawnPlunge ?? defaultSpawnPlunge;
  const env = () => (opts.env ? opts.env() : process.env);
  const now = () => (opts.now ? opts.now() : new Date());
  let seq = 0;

  const closed = (ws: Workspace | undefined): Refusal | undefined => {
    if (!ws) return { error: "behold isn't serving a declared chant workspace, and adoption is offered for a member of one.", code: "no-workspace" };
    return undefined;
  };
  const memberOf = (ws: Workspace, name: unknown): WorkspaceMember | undefined => (typeof name === "string" ? ws.members.find((m) => m.name === name) : undefined);
  const notOffered = (member: WorkspaceMember) => ({ error: ADOPTION_WAITS[member.kind] ?? `${member.name} is kind ${member.kind}, which behold offers no adoption for.`, code: "adopt-kind" });

  app.get("/api/adopt", (c) => {
    const ws = opts.workspace();
    const refusal = closed(ws);
    const offers = (ws?.members ?? []).flatMap((m): Record<string, unknown>[] => {
      const adopter = adopterFor(m.kind);
      if (!adopter) return ADOPTION_WAITS[m.kind] ? [{ member: m.name, kind: m.kind, dir: m.dir, offered: false, waits: ADOPTION_WAITS[m.kind] }] : [];
      if (m.kind === "pulumi") return [pulumiOffer(m, !!opts.preview?.())];
      return [];
    });
    return c.json({ refusal: refusal ?? null, recorded: null, offers }, 200, { "cache-control": "no-store" });
  });

  app.get("/api/adopt/report", async (c) => {
    const ws = opts.workspace();
    const refusal = closed(ws);
    if (refusal) return c.json(refusal, 404);
    const member = memberOf(ws!, c.req.query("member"));
    if (!member) return c.json({ error: "member names a member of the workspace", code: "adopt" }, 400);
    if (!adopterFor(member.kind)) return c.json(notOffered(member), 422);
    if (member.kind === "pulumi") {
      const planned = pulumiPlanFor(member, c.req.query("stack"));
      if (!planned.ok) return c.json({ error: planned.error, code: planned.code, remedy: PULUMI_ADOPTER.state }, planned.code === "adopt" ? 400 : 422);
      const { classification } = await classify(planned.plan, spawnPlunge, env());
      return c.json(pulumiReportOf(planned.plan, classification, member.kind), 200, { "cache-control": "no-store" });
    }
    return c.json(notOffered(member), 422);
  });

  app.post("/api/adopt/start", async (c) => {
    const ws = opts.workspace();
    const refusal = closed(ws);
    if (refusal) return c.json(refusal, 404);
    if (opts.preview?.()) return c.json({ error: "adoption is not started in preview mode", code: "preview" }, 403);
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json();
      body = isRecord(parsed) ? parsed : {};
    } catch {
      return c.json({ error: "the body is JSON: {member, stack?}", code: "adopt" }, 400);
    }
    const member = memberOf(ws!, body.member);
    if (!member) return c.json({ error: "member names a member of the workspace", code: "adopt" }, 400);
    if (!adopterFor(member.kind)) return c.json(notOffered(member), 422);
    if (member.kind !== "pulumi") return c.json(notOffered(member), 422);
    const planned = pulumiPlanFor(member, typeof body.stack === "string" ? body.stack : undefined);
    if (!planned.ok) return c.json({ error: planned.error, code: planned.code, remedy: PULUMI_ADOPTER.state }, planned.code === "adopt" ? 400 : 422);
    const plan = planned.plan;
    const id = `adopt-${(++seq).toString(36)}-${now().getTime().toString(36)}`;
    const rec: PulumiAdoptRun = { id, member: member.name, kind: member.kind, plan, startedAt: now().toISOString(), endedAt: null, exitCode: null, classification: null };
    const nudge = () => opts.broadcaster.emit("adopt-run", id);
    const started = opts.runner.track(`plunge stack adopt ${plan.stack} (${member.name}, classify only)`, async (io) => {
      io.line(`▶ ${plan.command}`);
      const { code, classification } = await classify(plan, spawnPlunge, env());
      rec.exitCode = code;
      rec.classification = classification;
      rec.endedAt = now().toISOString();
      io.line(String(pulumiRunOf(rec).words));
      nudge();
      // Without --yes plunge exits non-zero once it has listed everything: that is its gate holding, not a failure.
      return classification.outcome === "classified" || classification.outcome === "already-adopted" ? 0 : code || 1;
    });
    if (!started) return c.json({ error: `busy: ${opts.runner.running} is running`, code: "busy" }, 409);
    pulumiRuns.unshift(rec);
    pulumiRuns.splice(ADOPT_RUNS_KEPT);
    return c.json({ started: true, id, command: plan.command, confirm: plan.confirm }, 202);
  });

  app.get("/api/adopt/runs/:id", (c) => {
    const id = c.req.param("id");
    const rec = ID.test(id) ? pulumiRuns.find((r) => r.id === id) : undefined;
    if (!rec) return c.json({ absent: `behold has no adoption ${id}: it keeps the last ${ADOPT_RUNS_KEPT} it started, in memory.` }, 404, { "cache-control": "no-store" });
    return c.json(pulumiRunOf(rec), 200, { "cache-control": "no-store" });
  });
}
