/**
 * Live versus declared (#402, M5 of #397): the same estate predicted twice,
 * once as the account stands and once as the file says, with both figures and
 * their difference on the overlay payload.
 *
 * behold still calls no engine. Both predictions are chant's: `chant graph
 * --traffic "<level>"` asks the project's predicting lexicon about the file,
 * and the same read under `--live --env <env>` asks about the account
 * (chant#2377, chant#2488, chant#2495). What this module adds is the second
 * read, where the traffic level comes from, and one subtraction, labelled as
 * one.
 *
 * ## The traffic level
 *
 * `.behold.json`'s `{ "behaviour": { "traffic": "100 rps, p50" } }` is the
 * default, `?traffic=` overrides it per request, and with neither no
 * prediction is asked for at all. That last case reads as "not looked": the
 * contract forbids defaulting the level, because every figure is *at* a stated
 * traffic and inventing one would decide what every number on the graph means.
 *
 * ## Who reads what
 *
 *  - A **chant** member's overlay read is already `chant graph --live
 *    --overlay`, so the live half is that read with `--traffic` added: the
 *    blocks ride on `attrs._behaviour`, the channel src/behaviour.ts already
 *    reads. The declared half is one more source read.
 *  - A **choudoufu** member is read by choudoufu, not by chant, so neither
 *    half exists until behold asks. It asks through a generated reader project
 *    (src/terraform-member.ts's scratch project, with `binary: "choudoufu"`
 *    so the lexicon treats the root as live), read twice.
 *  - A **terraform** member has no live half (src/terraform-member.ts), so it
 *    has no delta either.
 *
 * ## What is cached
 *
 * The declared figure only moves when the file changes, which is the key
 * `memberIr` already caches under: the member's source stamp plus every option
 * of the read. So the declared half goes through `memberIr` and costs a chant
 * spawn once per edit. The live half goes through `overlayIr`, and is dropped
 * by exactly what drops the overlay it belongs to (a re-check that was asked
 * for, a write behold ran, a moved source). A figure about the account that
 * outlives the picture of the account would be the two disagreeing.
 *
 * ## The arithmetic
 *
 * `delta = live - declared`, per member and summed for the estate, and only
 * like with like: two figures the engine stated, or two sums behold added, in
 * one currency. Anything else yields no delta and a line saying why. A
 * negative delta means the account holds less than the file declares.
 */
import { basename, resolve } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { memberTakesTraffic, TRAFFIC_FLOOR, type GraphOptions } from "./chant.ts";
import type { MemberKind } from "./member-kind.ts";
import { memberIr, type MemberVia } from "./member-ir.ts";
import { overlayIr } from "./overlay-ir.ts";
import type { BeholdConfig } from "./project.ts";
import { choudoufuSpawnOverride } from "./choudoufu-member.ts";
import {
  TERRAFORM_LEXICON_PKG,
  TerraformReadError,
  terraformReaderState,
  terraformVia,
  type TerraformReaderState,
  writeTerraformScratchProject,
} from "./terraform-member.ts";
import {
  FIRST_TOTAL_SHOWN,
  validateBehaviourBlock,
  validateBehaviourMeta,
  type BehaviourBlock,
  type BehaviourMeta,
  type BehaviourReportMeta,
} from "./behaviour.ts";

/** The node attr the declared side's block rides on, beside `_behaviour`. */
export const DECLARED_ATTR = "_behaviourDeclared";

/** The traffic level this request predicts at: `?traffic=`, else the served
 * root's `.behold.json`, else none. Blank is none. */
export function trafficFor(query: URLSearchParams, config: BeholdConfig): string | undefined {
  const asked = query.get("traffic")?.trim();
  return asked || config.behaviour?.traffic || undefined;
}

// ---------------------------------------------------------------------------
// A prediction, as a report.
// ---------------------------------------------------------------------------

/** One side of one member, in the document shape src/behaviour.ts already
 * reads: the graph-level meta, and a block per entity address. */
export interface PredictedReport {
  meta: unknown;
  entities: Record<string, unknown>;
}

interface IrLike {
  nodes: { id: string; attrs?: Record<string, unknown> }[];
  meta?: unknown;
}

/**
 * What a `chant graph --traffic` read says, lifted off the IR: `meta.
 * _behaviour` and every node's `attrs._behaviour`, keyed by the node id with
 * `strip` taken off the front (a generated reader project keys a block
 * `<root>/<address>`, and the member's own nodes are keyed `<address>`).
 * Undefined when the read carries neither, which is chant saying it did not
 * look.
 */
export function reportFromIr(ir: IrLike, strip = ""): PredictedReport | undefined {
  const meta = (ir.meta as { _behaviour?: unknown } | undefined)?._behaviour;
  const entities: Record<string, unknown> = {};
  for (const n of ir.nodes) {
    const block = n.attrs?._behaviour;
    if (block === undefined) continue;
    entities[strip && n.id.startsWith(strip) ? n.id.slice(strip.length) : n.id] = block;
  }
  if (meta === undefined && Object.keys(entities).length === 0) return undefined;
  return { meta, entities };
}

/** Both sides of one member, or why there is none. */
export interface MemberPrediction {
  /** Present only for a member whose own overlay read is not chant's: the
   * blocks to paint before src/behaviour.ts reads the overlay. */
  live?: PredictedReport;
  declared?: PredictedReport;
  /** Why a side is missing, in one line. */
  note?: string;
}

// ---------------------------------------------------------------------------
// The choudoufu member's reader.
// ---------------------------------------------------------------------------

/** How a choudoufu member is predicted: a generated reader project whose one
 * root is the member, read by behold's own chant. A `MemberVia`, so both
 * caches key it the way they key every other read: the member's OWN directory
 * is stamped, and the lexicon's version is the tool. */
export function choudoufuPredictVia(
  read: (project: string, opts: GraphOptions) => Promise<GraphIR>,
  readerState: () => TerraformReaderState = terraformReaderState,
): MemberVia {
  return {
    tool: () => `${TERRAFORM_LEXICON_PKG}\0predict\0${readerState().lexicon.version ?? "absent"}`,
    read: async (dir, opts) => {
      const state = readerState();
      if (state.refusal) throw new TerraformReadError(state.refusal, dir);
      // The member IS the root. No scan: src/terraform-member.ts's probe asks
      // whether a directory of `.tf` looks like a root, and this one was
      // already served as a choudoufu estate, sidecar-declared ones included,
      // which that probe would turn away.
      const own = [{ name: basename(dir), dir: "." }];
      const project = writeTerraformScratchProject(dir, { roots: own, skipped: [] }, undefined, "chdf");
      const spawnEnv = choudoufuSpawnOverride();
      const ir = await read(project, {
        traffic: opts.traffic,
        ...(opts.live ? { live: true, env: opts.env } : {}),
        ...(spawnEnv ? { spawnEnv } : {}),
      });
      // The root's name is the only prefix this project can put on an id, and
      // it is recorded here so the caller strips exactly it.
      return Object.assign(ir, { behaviourRoot: own[0].name });
    },
  };
}

const rootPrefix = (ir: GraphIR): string => {
  const root = (ir as { behaviourRoot?: string }).behaviourRoot;
  return root ? `${root}/` : "";
};

const said = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0];

export interface PredictMemberDeps {
  /** One chant graph read of a project. `graphIr` in production. */
  read: (project: string, opts: GraphOptions) => Promise<GraphIR>;
  /** Whether the optional terraform lexicon is installed. The real probe in
   * production; a test has no lexicon to find. */
  readerState?: () => TerraformReaderState;
}

/**
 * Both sides of one member at `traffic`.
 *
 * `fresh` is the caller's re-check, and it reaches the live half only: the
 * declared half is about the file, and a request to look at the account again
 * is not a reason to read the file again.
 */
export async function predictMember(
  member: { dir: string; kind: MemberKind },
  env: string | undefined,
  traffic: string,
  deps: PredictMemberDeps,
  fresh = false,
): Promise<MemberPrediction> {
  const dir = resolve(member.dir);
  if (member.kind === "terraform") {
    try {
      const declared = reportFromIr((await memberIr(dir, { traffic }, terraformVia)) as IrLike);
      return declared ? { declared } : {};
    } catch (err) {
      return { note: `declared prediction unavailable: ${said(err)}` };
    }
  }
  if (member.kind === "choudoufu") {
    const via = choudoufuPredictVia(deps.read, deps.readerState);
    const notes: string[] = [];
    const side = async (from: "live" | "declared"): Promise<PredictedReport | undefined> => {
      try {
        const ir = from === "live" ? await overlayIr(dir, { traffic, live: true, env }, via, fresh) : await memberIr(dir, { traffic }, via);
        return reportFromIr(ir as IrLike, rootPrefix(ir));
      } catch (err) {
        notes.push(`${from} prediction unavailable: ${said(err)}`);
        return undefined;
      }
    };
    // No env is `/api/graph`: the source graph, which has no live half.
    const [live, declared] = await Promise.all([env === undefined ? undefined : side("live"), side("declared")]);
    return { ...(live ? { live } : {}), ...(declared ? { declared } : {}), ...(notes.length ? { note: notes.join("; ") } : {}) };
  }
  if (member.kind === "chant" && memberTakesTraffic(dir, "chant")) {
    try {
      const declared = reportFromIr((await memberIr(dir, { traffic })) as IrLike);
      return declared ? { declared } : {};
    } catch (err) {
      return { note: `declared prediction unavailable: ${said(err)}` };
    }
  }
  if (member.kind === "chant") {
    return { note: `this member's chant predates \`graph --traffic\` (${TRAFFIC_FLOOR}), so nothing was predicted for it` };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Onto the overlay.
// ---------------------------------------------------------------------------

interface Ir {
  nodes: { id: string; attrs?: Record<string, unknown> }[];
}

const idFor = (name: string | undefined, address: string): string => (name === undefined ? address : `${name}/${address}`);

/**
 * Paint a member's live report onto its overlay nodes as `attrs._behaviour`,
 * so src/behaviour.ts reads it through the channel it already prefers. Returns
 * the report's meta for that pass to validate, and names every address the
 * overlay has no node for.
 */
export function paintLive(ir: Ir, name: string | undefined, report: PredictedReport, diagnostics: string[]): unknown {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  for (const [address, block] of Object.entries(report.entities)) {
    const node = byId.get(idFor(name, address));
    if (!node) {
      diagnostics.push(`${name ?? "the project"}: the live prediction prices ${address}, which this overlay has no entity for`);
      continue;
    }
    node.attrs = { ...node.attrs, _behaviour: block };
  }
  return report.meta;
}

/** One side's figure for one member or for the estate, and whose it is. */
export interface BehaviourFigure {
  perHour: number;
  currency: string;
  /** `total` is a figure the engine stated; `sum` is behold adding the
   * engine's per-entity figures, as `meta.behaviour.sum` already is. */
  basis: "total" | "sum";
}

/** `live - declared`. Never a figure of its own: both operands are on the
 * payload beside it. */
export interface BehaviourDelta {
  perHour: number;
  currency: string;
}

export interface MemberDelta {
  live?: BehaviourFigure;
  declared?: BehaviourFigure;
  delta?: BehaviourDelta;
}

/** What #402 adds to `meta.behaviour`. */
export interface BehaviourDeltaMeta {
  live?: BehaviourFigure;
  declared?: BehaviourFigure;
  delta?: BehaviourDelta;
  /** The same three per served member, keyed by the member's composed name. */
  members?: Record<string, MemberDelta>;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** A side's figure: the engine's total where it stated one, else the sum of
 * the blocks, else nothing. Mixed currencies are nothing, with the reason. */
function figureOf(meta: BehaviourReportMeta | undefined, blocks: BehaviourBlock[], onMixed: (currencies: string[]) => void): BehaviourFigure | undefined {
  if (meta?.total) return { perHour: meta.total.perHour, currency: meta.total.currency, basis: "total" };
  if (!blocks.length) return undefined;
  const currencies = [...new Set(blocks.map((b) => b.cost.currency))].sort();
  if (currencies.length > 1) {
    onMixed(currencies);
    return undefined;
  }
  return { perHour: round6(blocks.reduce((sum, b) => sum + b.cost.perHour, 0)), currency: currencies[0], basis: "sum" };
}

function deltaOf(live: BehaviourFigure | undefined, declared: BehaviourFigure | undefined, label: string, diagnostics: string[]): BehaviourDelta | undefined {
  if (!live || !declared) return undefined;
  if (live.currency !== declared.currency) {
    diagnostics.push(`no delta for ${label}: the live figure is in ${live.currency} and the declared one in ${declared.currency}`);
    return undefined;
  }
  if (live.basis !== declared.basis) {
    diagnostics.push(`no delta for ${label}: one side is the engine's own total and the other is behold's sum, and those are not the same kind of figure`);
    return undefined;
  }
  return { perHour: round6(live.perHour - declared.perHour), currency: live.currency };
}

/** One served member, as this pass needs it. `liveMeta` is `meta._behaviour`
 * as the member's live side carried it (its own overlay read, or the report
 * `paintLive` painted). */
export interface DeltaMember {
  name?: string;
  liveMeta?: unknown;
  prediction: MemberPrediction;
}

/**
 * Put the declared side on the overlay and answer the delta.
 *
 * Runs after `attachBehaviour`, so every `_behaviour` left on a node is a
 * validated block and a refusal has already cleared them. Mutates `ir.nodes`:
 * a validated declared block lands on `attrs._behaviourDeclared`, including on
 * a node the account no longer holds, which is where a delta comes from.
 * Returns `meta.behaviour` extended, never replaced.
 */
export function attachBehaviourDelta(ir: Ir, members: readonly DeltaMember[], behaviour: BehaviourMeta): BehaviourMeta & BehaviourDeltaMeta {
  const diagnostics: string[] = [...(behaviour.diagnostics ?? [])];
  const perMember: Record<string, MemberDelta> = {};
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));

  for (const m of members) {
    const label = m.name ?? "the project";
    if (m.prediction.note) diagnostics.push(`${label}: ${m.prediction.note}`);
    const slice = m.name === undefined ? ir.nodes : ir.nodes.filter((n) => n.id.startsWith(`${m.name}/`));

    const liveMeta = m.liveMeta === undefined ? undefined : validateBehaviourMeta(m.liveMeta);
    const liveBlocks = slice.map((n) => n.attrs?._behaviour as BehaviourBlock | undefined).filter((b): b is BehaviourBlock => !!b);
    const live = behaviour.refusal
      ? undefined
      : figureOf(liveMeta?.ok ? liveMeta.value : undefined, liveBlocks, (cs) => diagnostics.push(`no live figure for ${label}: the figures are in ${cs.join(" and ")}`));

    let declared: BehaviourFigure | undefined;
    const report = m.prediction.declared;
    if (report) {
      const meta = validateBehaviourMeta(report.meta);
      if (!meta.ok) diagnostics.push(`${label}: dropped the declared prediction's meta — ${meta.reason}`);
      else if (meta.value.refusal) diagnostics.push(`${label}: the declared prediction was refused — ${meta.value.refusal.reason}`);
      else {
        const blocks: BehaviourBlock[] = [];
        for (const [address, raw] of Object.entries(report.entities)) {
          const v = validateBehaviourBlock(raw);
          if (!v.ok) {
            diagnostics.push(`dropped the declared behaviour block on ${idFor(m.name, address)}: ${v.reason}`);
            continue;
          }
          blocks.push(v.value);
          const node = byId.get(idFor(m.name, address));
          if (node) node.attrs = { ...node.attrs, [DECLARED_ATTR]: v.value };
        }
        declared = figureOf(meta.value, blocks, (cs) => diagnostics.push(`no declared figure for ${label}: the figures are in ${cs.join(" and ")}`));
      }
    }

    const delta = deltaOf(live, declared, label, diagnostics);
    if (live || declared) perMember[label] = { ...(live ? { live } : {}), ...(declared ? { declared } : {}), ...(delta ? { delta } : {}) };
  }

  // The estate's three are the members' added, and only when every member
  // that has a side has it in the same terms: a sum over some members would
  // be a figure about an estate nobody asked about.
  const rows = Object.values(perMember);
  const addUp = (side: "live" | "declared"): BehaviourFigure | undefined => {
    const figures = rows.map((r) => r[side]).filter((f): f is BehaviourFigure => !!f);
    if (!figures.length || figures.length !== rows.length) return undefined;
    if (new Set(figures.map((f) => f.currency)).size > 1) return undefined;
    const basis = figures.every((f) => f.basis === "total") && figures.length === 1 ? "total" : "sum";
    return { perHour: round6(figures.reduce((sum, f) => sum + f.perHour, 0)), currency: figures[0].currency, basis };
  };
  const live = addUp("live");
  const declared = addUp("declared");
  const allDeltas = rows.length > 0 && rows.every((r) => r.delta);
  const delta = live && declared && allDeltas ? { perHour: round6(live.perHour - declared.perHour), currency: live.currency } : undefined;

  const out: BehaviourMeta & BehaviourDeltaMeta = { ...behaviour };
  // Each member is predicted on its own, so an estate of several has several
  // engine totals and `attachBehaviour` shows the first. Beside `live`, which
  // adds them all and says it is a sum, one member's total labelled as the
  // estate's is simply a wrong figure, so it goes, and its diagnostic with it.
  const stated = rows.filter((r) => r.live?.basis === "total").length;
  if (live && stated > 1) {
    delete out.total;
    const at = diagnostics.indexOf(FIRST_TOTAL_SHOWN);
    if (at >= 0) diagnostics.splice(at, 1);
  }
  if (live) out.live = live;
  if (declared) out.declared = declared;
  if (delta) out.delta = delta;
  if (rows.length && members.some((m) => m.name !== undefined)) out.members = perMember;
  if (diagnostics.length) out.diagnostics = diagnostics;
  else delete out.diagnostics;
  return out;
}

/**
 * The declared side alone, on the source graph (`/api/graph`): each member's
 * declared blocks land on `attrs._behaviour`, because on this route the file
 * is the only estate there is, and the meta says whose figures they are.
 * A refusal clears every block, as it does on the overlay.
 */
export function attachDeclaredBehaviour(ir: Ir, members: readonly { name?: string; prediction: MemberPrediction }[]): BehaviourMeta & BehaviourDeltaMeta {
  const diagnostics: string[] = [];
  const perMember: Record<string, MemberDelta> = {};
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  let first: BehaviourReportMeta | undefined;

  for (const m of members) {
    const label = m.name ?? "the project";
    if (m.prediction.note) diagnostics.push(`${label}: ${m.prediction.note}`);
    const report = m.prediction.declared;
    if (!report) continue;
    const meta = validateBehaviourMeta(report.meta);
    if (!meta.ok) {
      diagnostics.push(`${label}: dropped the declared prediction's meta — ${meta.reason}`);
      continue;
    }
    if (meta.value.refusal) {
      for (const n of ir.nodes) if (n.attrs?._behaviour !== undefined) delete n.attrs._behaviour;
      return { refusal: meta.value.refusal };
    }
    first ??= meta.value;
    const blocks: BehaviourBlock[] = [];
    for (const [address, raw] of Object.entries(report.entities)) {
      const v = validateBehaviourBlock(raw);
      if (!v.ok) {
        diagnostics.push(`dropped the behaviour block on ${idFor(m.name, address)}: ${v.reason}`);
        continue;
      }
      blocks.push(v.value);
      const node = byId.get(idFor(m.name, address));
      if (node) node.attrs = { ...node.attrs, _behaviour: v.value };
    }
    const declared = figureOf(meta.value, blocks, (cs) => diagnostics.push(`no declared figure for ${label}: the figures are in ${cs.join(" and ")}`));
    if (declared) perMember[label] = { declared };
  }

  if (!first) {
    return {
      absent: "no behaviour block: a traffic level was given and no member's declared prediction came back",
      ...(diagnostics.length ? { diagnostics } : {}),
    };
  }
  const figures = Object.values(perMember).map((r) => r.declared!);
  const oneCurrency = new Set(figures.map((f) => f.currency)).size === 1;
  const declared: BehaviourFigure | undefined =
    figures.length && oneCurrency
      ? { perHour: round6(figures.reduce((sum, f) => sum + f.perHour, 0)), currency: figures[0].currency, basis: figures.length === 1 ? figures[0].basis : "sum" }
      : undefined;
  return {
    ...(first.engine ? { engine: first.engine } : {}),
    ...(first.version ? { version: first.version } : {}),
    ...(first.at ? { at: first.at } : {}),
    ...(declared ? { declared } : {}),
    ...(members.some((m) => m.name !== undefined) && figures.length ? { members: perMember } : {}),
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}
