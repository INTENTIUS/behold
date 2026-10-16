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
}

export interface TerralithPhase {
  id: TerralithPhaseId;
  n: number;
  at?: string;
  choudoufu?: string;
  boxes: TerralithBox[];
  counts: { cards: number; marked: number; marker: number; derived: number; state: number; moved: number };
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

/** One phase directory, read. Undefined when its phase.json is not there yet. */
export function readTerralithPhase(snapshots: string, phase: (typeof TERRALITH_PHASES)[number], before?: TerralithPhase): TerralithPhase | undefined {
  const dir = join(snapshots, phase.dir);
  const notes: string[] = [];
  const meta = readJson(join(dir, "phase.json"), notes, "phase.json");
  if (!isRecord(meta)) return undefined;
  const roots = Array.isArray(meta.roots) ? meta.roots.filter((r): r is string => typeof r === "string") : [];
  const retags = retagsOf(dir, notes);
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
      };
    });
    cards.sort(cardOrder);
    return { id: root, ...(estate ? { estate } : {}), stock: !estate, spawned: !!before && !seen.has(root), cards };
  });
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
    },
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
