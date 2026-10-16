/**
 * `behold demo terralith`: the snapshot reader and the walkthrough's model.
 *
 * The demo copy's scripts run every write (a stock apply, `live-import
 * -approve`, `live-mv`) against a scratch floci, and after each phase they
 * write choudoufu's own documents as files under `snapshots/<n>-<phase>/`:
 *
 *   phase.json                    written last: {phase, n, at, choudoufu, roots[]}
 *   <root>/live-check.json        the declared instances (offline)
 *   <root>/state.json             a stock root: `show -json` of its state
 *   <root>/live-import.txt        adopt: the read-only ratification report
 *   <root>/live-ls.json           an estate: what carries its marker
 *   <root>/live-plan.json         an estate: how each instance was bound
 *   live-mv/<root>--<addr>.json   split: each retag's own document
 *   <root>/cone.json              plan: `live-cone -json HEAD`, the change's cone
 *   <root>/plan.log               plan: the plan's own words (a cone that fell back says why)
 *   terralith/plan.json           plan: `show -json` of the terralith's saved plan
 *   set.json                      plan: `live-plan-set -json` over the team roots
 *   summary.json                  plan: `live-summary -json` of set.json, the folded groups
 *
 * This module reads those files and nothing else: no choudoufu spawn, no
 * cloud call, no write. The same files can come from a pipeline, which is
 * why the reader takes a directory and not a run.
 *
 * The mark (web/identity-mark.js draws it) keeps choudoufu's two facts
 * apart, because choudoufu keeps them apart. `live-plan`'s `bound[].source`
 * says how the plan found the instance: `marker` when the estate-wide tag
 * sweep bound it, `derived` when the configuration names it (an IAM role's
 * name, a log group's name), with or without a marker on the object
 * (choudoufu internal/command/views/live_plan.go, LivePlanBoundDerived).
 * `live-ls` says whether the object carries this estate's marker. A stamped
 * log group is `derived` and carries the marker; an inline policy is
 * `derived` and has nowhere to carry one.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TERRALITH_PHASES = [
  { id: "stock", n: 1, dir: "1-stock" },
  { id: "adopt", n: 2, dir: "2-adopt" },
  { id: "split", n: 3, dir: "3-split" },
  { id: "plan", n: 4, dir: "4-plan" },
] as const;

export type TerralithPhaseId = (typeof TERRALITH_PHASES)[number]["id"];

/** The mark a card wears. `state`: a stock root, identity in the state file.
 * `marker`: bound by its marker. `derived`: bound by the name the code
 * gives it; `marked` says whether the object carries the marker too. */
export interface CardIdentity {
  source: "state" | "marker" | "derived" | "record" | "cache" | "unbound";
  marked: boolean;
}

export interface TerralithCard {
  /** The address; the same id in every phase, so a card glides. */
  id: string;
  type: string;
  root: string;
  identity: CardIdentity;
  /** The live object's id, as the state, the plan or the listing gives it. */
  liveId?: string;
  /** adopt: `live-import`'s verdict, lower case (verified, drifted, untaggable, missing). */
  ratified?: string;
  /** split: the retag that moved it here. */
  moved?: { from: string; to: string; follows?: string };
  /** plan: what the root's plan would do to it, and the attributes it changes (names only). */
  planned?: { actions: string[]; attributes: string[] };
  /** plan: inside the cone `live-cone` printed for its root. */
  inCone?: boolean;
}

/** plan: one root's cone and how its plan ran. */
export interface RootPlan {
  /** `live-cone`'s answer: the blocks the change reaches, or the guard's reason to plan in full. */
  cone?: { full: boolean; kind?: string; reason?: string; blocks: number; coneBlocks: number };
  /** The plan's own "fell back to a full plan" words, when it did. */
  fallback?: { kind: string; reason: string };
  /** The changes the root's plan holds. */
  changes: number;
  /** The folded group (summary.json) this root is in. */
  group?: number;
}

/** plan: identical changes across roots, as live-summary folds them. */
export interface PlanGroup {
  id: number;
  members: string[];
  changes: Array<{ line: string; action: string }>;
}

/** plan: an output one estate plans and others read through terraform_estate_outputs. */
export interface PlannedOutput {
  /** The producing estate and the root that holds it. */
  estate: string;
  root?: string;
  name: string;
  /** The planned value; absent when only known after apply, or sensitive. */
  value?: unknown;
  known: boolean;
  /** The roots that read it. */
  readers: string[];
}

export interface TerralithBox {
  /** The root directory, which is also the box's id across phases. */
  id: string;
  /** The estate its live block names; absent on a stock root. */
  estate?: string;
  stock: boolean;
  /** True when the root was not in the phase before. */
  spawned: boolean;
  cards: TerralithCard[];
  /** plan: the root's cone and plan. */
  plan?: RootPlan;
}

export interface TerralithPhase {
  id: TerralithPhaseId;
  n: number;
  at?: string;
  choudoufu?: string;
  boxes: TerralithBox[];
  counts: { cards: number; marked: number; marker: number; derived: number; state: number; moved: number; planned: number };
  /** plan: the folded groups and the planned outputs that cross estates. */
  plan?: { groups: PlanGroup[]; outputs: PlannedOutput[] };
  /** Files in the phase that could not be read, named, with why. */
  notes: string[];
}

export interface TerralithModel {
  phases: TerralithPhase[];
  /** The phase to run next, and the line that runs it; absent when all ran. */
  next?: { id: TerralithPhaseId; n: number; command: string };
  /** split.json, when the split phase wrote one. */
  split?: { moves: number; estates: string[] };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One JSON file, or why not. A missing file is `undefined` with no note. */
function readJson(path: string, notes: string[], label: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    notes.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** `live-import`'s ratification report as `address -> status`. The grammar
 * terragucci reads too (packages/terragucci/src/migrate-estate.ts
 * `parseRatification`): a `STATUS (n) - ...` heading, then one row per
 * instance, `  <address>  <type>  live id: <id>`. */
export function parseRatification(text: string): Map<string, { status: string; liveId?: string }> {
  const out = new Map<string, { status: string; liveId?: string }>();
  let status: string | undefined;
  for (const line of text.split("\n")) {
    const head = /^([A-Z_]+) \(\d+\) - /.exec(line);
    if (head) {
      status = ["VERIFIED", "DRIFTED", "MISSING", "UNTAGGABLE", "UNADMITTED_TYPE"].includes(head[1]!) ? head[1] : undefined;
      continue;
    }
    if (/eligible for stamping/.test(line)) status = undefined;
    const row = /^ {2}(\S+)\s+(\S+)\s+live id: (\S+)\s*$/.exec(line);
    if (status && row) out.set(row[1]!, { status: status.toLowerCase(), ...(row[3] !== "-" ? { liveId: row[3]! } : {}) });
  }
  return out;
}

/** Declared instances off `live-check -json`: address and type. */
function declared(doc: unknown): Array<{ address: string; type: string }> {
  if (!isRecord(doc) || !Array.isArray(doc.instances)) return [];
  return doc.instances.flatMap((i) => (isRecord(i) && typeof i.address === "string" ? [{ address: i.address, type: typeof i.type === "string" ? i.type : i.address.split(".")[0]! }] : []));
}

/** A stock root's state, as `show -json` prints it: address -> live id. */
function stateIds(doc: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (mod: unknown): void => {
    if (!isRecord(mod)) return;
    for (const r of Array.isArray(mod.resources) ? mod.resources : []) {
      if (isRecord(r) && typeof r.address === "string" && r.mode === "managed") {
        const id = isRecord(r.values) && typeof r.values.id === "string" ? r.values.id : "";
        out.set(r.address, id);
      }
    }
    for (const c of Array.isArray(mod.child_modules) ? mod.child_modules : []) walk(c);
  };
  if (isRecord(doc) && isRecord(doc.values)) walk(doc.values.root_module);
  return out;
}

/** Order cards so each team's resources sit together: by resource name, then type. */
const cardOrder = (a: TerralithCard, b: TerralithCard): number => {
  const name = (c: TerralithCard) => c.id.split(".").slice(1).join(".");
  return name(a).localeCompare(name(b)) || a.type.localeCompare(b.type);
};

/** The retags a split phase recorded: address -> {from, to, followers}. */
function retagsOf(dir: string, notes: string[]): Map<string, { from: string; to: string; follows?: string }> {
  const out = new Map<string, { from: string; to: string; follows?: string }>();
  const mv = join(dir, "live-mv");
  if (!existsSync(mv)) return out;
  for (const f of readdirSync(mv).sort()) {
    if (!f.endsWith(".json") || f.endsWith(".dry-run.json")) continue;
    const doc = readJson(join(mv, f), notes, `live-mv/${f}`);
    if (!isRecord(doc) || !isRecord(doc.from) || !isRecord(doc.to) || doc.written !== true) continue;
    const from = String(doc.from.estate ?? "");
    const to = String(doc.to.estate ?? "");
    const address = String(doc.to.address ?? doc.from.address ?? "");
    if (!address) continue;
    out.set(address, { from, to });
    for (const fo of Array.isArray(doc.followers) ? doc.followers : []) {
      if (isRecord(fo) && typeof fo.address === "string") out.set(fo.address, { from, to, follows: address });
    }
  }
  return out;
}

/** A plan's resource changes (`show -json`): address -> actions and changed attribute names. */
function plannedChanges(plan: unknown): Map<string, { actions: string[]; attributes: string[] }> {
  const out = new Map<string, { actions: string[]; attributes: string[] }>();
  if (!isRecord(plan) || !Array.isArray(plan.resource_changes)) return out;
  for (const rc of plan.resource_changes) {
    if (!isRecord(rc) || typeof rc.address !== "string" || !isRecord(rc.change)) continue;
    const actions = Array.isArray(rc.change.actions) ? rc.change.actions.filter((a): a is string => typeof a === "string") : [];
    if (!actions.length || actions.every((a) => a === "no-op" || a === "read")) continue;
    const before = isRecord(rc.change.before) ? rc.change.before : {};
    const after = isRecord(rc.change.after) ? rc.change.after : {};
    const unknown = isRecord(rc.change.after_unknown) ? rc.change.after_unknown : {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(unknown)]);
    const attributes = [...keys].filter((k) => unknown[k] === true || JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
    out.set(rc.address, { actions, attributes });
  }
  return out;
}

/** The estates a root's configuration reads outputs of (`data "terraform_estate_outputs"`), with the names. */
function outputReads(plan: unknown): Array<{ estate: string; names: string[] }> {
  if (!isRecord(plan) || !isRecord(plan.configuration) || !isRecord(plan.configuration.root_module)) return [];
  const resources = plan.configuration.root_module.resources;
  return (Array.isArray(resources) ? resources : []).flatMap((r) => {
    if (!isRecord(r) || r.mode !== "data" || r.type !== "terraform_estate_outputs" || !isRecord(r.expressions)) return [];
    const estate = isRecord(r.expressions.estate) ? r.expressions.estate.constant_value : undefined;
    const names = isRecord(r.expressions.names) ? r.expressions.names.constant_value : undefined;
    return typeof estate === "string" ? [{ estate, names: Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [] }] : [];
  });
}

/** A plan log's "Cone plan fell back to a full plan" warning: its guard and its sentence. */
export function coneFallback(log: string): { kind: string; reason: string } | undefined {
  const text = log.replace(/\x1b\[[0-9;]*m/g, "").replace(/^[│╷╵ ]+/gm, "");
  const m = /Cone plan fell back to a full plan\s+This plan covers the whole estate \(guard ([a-z-]+)\):\s*([\s\S]*?)(?:\n\s*\n|$)/.exec(text);
  return m ? { kind: m[1]!, reason: m[2]!.replace(/\s+/g, " ").trim() } : undefined;
}

/** One phase directory, read. Undefined when its phase.json is not there yet. */
export function readTerralithPhase(snapshots: string, phase: (typeof TERRALITH_PHASES)[number], before?: TerralithPhase): TerralithPhase | undefined {
  const dir = join(snapshots, phase.dir);
  const notes: string[] = [];
  const meta = readJson(join(dir, "phase.json"), notes, "phase.json");
  if (!isRecord(meta)) return undefined;
  const roots = Array.isArray(meta.roots) ? meta.roots.filter((r): r is string => typeof r === "string") : [];
  const retags = retagsOf(dir, notes);
  // The plan phase's documents: each team root's plan from the set, the terralith's own.
  const set = readJson(join(dir, "set.json"), notes, "set.json");
  const setPlans = new Map<string, unknown>();
  if (isRecord(set) && Array.isArray(set.roots)) {
    for (const r of set.roots) if (isRecord(r) && typeof r.root === "string") setPlans.set(r.root, r.plan);
  }
  const planOf = (root: string): unknown => setPlans.get(root) ?? readJson(join(dir, root, "plan.json"), notes, `${root}/plan.json`);
  const seen = new Set(before?.boxes.map((b) => b.id) ?? []);
  const boxes: TerralithBox[] = roots.map((root) => {
    const at = (f: string) => join(dir, root, f);
    const check = readJson(at("live-check.json"), notes, `${root}/live-check.json`);
    const estate = isRecord(check) && typeof check.estate === "string" && check.estate ? check.estate : undefined;
    const state = readJson(at("state.json"), notes, `${root}/state.json`);
    const ls = readJson(at("live-ls.json"), notes, `${root}/live-ls.json`);
    const plan = readJson(at("live-plan.json"), notes, `${root}/live-plan.json`);
    const ratified = existsSync(at("live-import.txt")) ? parseRatification(readFileSync(at("live-import.txt"), "utf8")) : new Map();
    const ids = stateIds(state);
    const cone = readJson(at("cone.json"), notes, `${root}/cone.json`);
    const planDoc = planOf(root);
    const changes = plannedChanges(planDoc);
    const inCone = new Set<string>(isRecord(cone) && isRecord(cone.guard) && cone.guard.full !== true && Array.isArray(cone.targets) ? cone.targets.filter((t): t is string => typeof t === "string") : []);
    const listed = new Map<string, string>();
    if (isRecord(ls) && Array.isArray(ls.items)) {
      for (const i of ls.items) {
        if (isRecord(i) && typeof i.address === "string" && isRecord(i.tags) && i.tags["tofu-estate"] === estate) listed.set(i.address, String(i.id ?? ""));
      }
    }
    const bound = new Map<string, { source: string; identity?: string }>();
    if (isRecord(plan) && Array.isArray(plan.bound)) {
      for (const b of plan.bound) {
        if (isRecord(b) && typeof b.addr === "string") bound.set(b.addr, { source: String(b.source ?? ""), ...(typeof b.identity === "string" ? { identity: b.identity } : {}) });
      }
    }
    const cards = declared(check).map((d): TerralithCard => {
      const b = bound.get(d.address);
      const r = ratified.get(d.address);
      const source: CardIdentity["source"] = !estate
        ? "state"
        : b && ["marker", "derived", "record", "cache"].includes(b.source)
          ? (b.source as CardIdentity["source"])
          : "unbound";
      const liveId = b?.identity || listed.get(d.address) || ids.get(d.address) || r?.liveId;
      const moved = retags.get(d.address);
      return {
        id: d.address,
        type: d.type,
        root,
        identity: { source, marked: listed.has(d.address) },
        ...(liveId ? { liveId } : {}),
        ...(r ? { ratified: r.status } : {}),
        ...(moved && moved.to === estate ? { moved } : {}),
        ...(changes.has(d.address) ? { planned: changes.get(d.address)! } : {}),
        ...(inCone.has(d.address) ? { inCone: true } : {}),
      };
    });
    cards.sort(cardOrder);
    const log = existsSync(at("plan.log")) ? readFileSync(at("plan.log"), "utf8") : "";
    const fallback = log ? coneFallback(log) : undefined;
    const rootPlan: RootPlan | undefined =
      isRecord(cone) || planDoc !== undefined
        ? {
            ...(isRecord(cone) && isRecord(cone.guard)
              ? {
                  cone: {
                    full: cone.guard.full === true,
                    ...(typeof cone.guard.kind === "string" ? { kind: cone.guard.kind } : {}),
                    ...(typeof cone.guard.reason === "string" ? { reason: cone.guard.reason } : {}),
                    blocks: typeof cone.blocks === "number" ? cone.blocks : 0,
                    coneBlocks: typeof cone.cone_blocks === "number" ? cone.cone_blocks : 0,
                  },
                }
              : {}),
            ...(fallback ? { fallback } : {}),
            changes: changes.size,
          }
        : undefined;
    return { id: root, ...(estate ? { estate } : {}), stock: !estate, spawned: !!before && !seen.has(root), cards, ...(rootPlan ? { plan: rootPlan } : {}) };
  });
  // The folded groups, and the outputs one estate plans for others to read.
  const summary = readJson(join(dir, "summary.json"), notes, "summary.json");
  const groups: PlanGroup[] =
    isRecord(summary) && Array.isArray(summary.groups)
      ? summary.groups.flatMap((g) =>
          isRecord(g) && typeof g.id === "number" && Array.isArray(g.members)
            ? [
                {
                  id: g.id,
                  members: g.members.filter((m): m is string => typeof m === "string"),
                  changes: (Array.isArray(g.changes) ? g.changes : []).flatMap((c) => (isRecord(c) && typeof c.line === "string" ? [{ line: c.line, action: String(c.action ?? "") }] : [])),
                },
              ]
            : [],
        )
      : [];
  for (const g of groups) for (const m of g.members) {
    const box = boxes.find((b) => b.id === m);
    if (box?.plan) box.plan.group = g.id;
  }
  const outputs: PlannedOutput[] = [];
  for (const box of boxes) {
    for (const read of outputReads(planOf(box.id))) {
      const producer = boxes.find((b) => b.estate === read.estate);
      const planned = producer ? planOf(producer.id) : undefined;
      const values = isRecord(planned) && isRecord(planned.planned_values) && isRecord(planned.planned_values.outputs) ? planned.planned_values.outputs : {};
      for (const name of read.names) {
        let o = outputs.find((x) => x.estate === read.estate && x.name === name);
        if (!o) {
          const v = values[name];
          const known = isRecord(v) && "value" in v && v.sensitive !== true;
          o = { estate: read.estate, ...(producer ? { root: producer.id } : {}), name, ...(known ? { value: (v as Record<string, unknown>).value } : {}), known, readers: [] };
          outputs.push(o);
        }
        o.readers.push(box.id);
      }
    }
  }
  const all = boxes.flatMap((b) => b.cards);
  return {
    id: phase.id,
    n: phase.n,
    ...(typeof meta.at === "string" ? { at: meta.at } : {}),
    ...(typeof meta.choudoufu === "string" ? { choudoufu: meta.choudoufu } : {}),
    boxes,
    counts: {
      cards: all.length,
      marked: all.filter((c) => c.identity.marked).length,
      marker: all.filter((c) => c.identity.source === "marker").length,
      derived: all.filter((c) => c.identity.source === "derived").length,
      state: all.filter((c) => c.identity.source === "state").length,
      moved: all.filter((c) => c.moved).length,
      planned: all.filter((c) => c.planned).length,
    },
    ...(groups.length || outputs.length ? { plan: { groups, outputs } } : {}),
    notes,
  };
}

/** The line that runs a phase, from the demo copy's root. */
export function phaseCommand(id: TerralithPhaseId): string {
  return id === "stock" ? "bash scripts/terralith-up.sh" : `bash scripts/terralith-step.sh ${id}`;
}

/** Every phase that has run, in order, and the one to run next. */
export function readTerralith(root: string): TerralithModel {
  const snapshots = join(root, "snapshots");
  const phases: TerralithPhase[] = [];
  for (const p of TERRALITH_PHASES) {
    const read = readTerralithPhase(snapshots, p, phases[phases.length - 1]);
    if (!read) break;
    phases.push(read);
  }
  const nextPhase = TERRALITH_PHASES[phases.length];
  const notes: string[] = [];
  const split = readJson(join(root, "split.json"), notes, "split.json");
  return {
    phases,
    ...(nextPhase ? { next: { id: nextPhase.id, n: nextPhase.n, command: phaseCommand(nextPhase.id) } } : {}),
    ...(isRecord(split) && Array.isArray(split.moves)
      ? { split: { moves: split.moves.length, estates: Array.isArray(split.estates) ? split.estates.filter((e): e is string => typeof e === "string") : [] } }
      : {}),
  };
}
