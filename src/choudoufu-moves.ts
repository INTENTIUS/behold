/**
 * The choudoufu move plan (#371, M3 of #366): cards gliding between member
 * boxes, the handoff lines a human runs, and the receipt read back.
 *
 * A move in choudoufu is one tag write: `live-mv -from-estate=<from> <addr>
 * <addr'>`, run in the DESTINATION estate's directory, rewrites the live
 * object's `tofu-estate` (and `tofu-address`) marker, and the untaggable
 * children that ride the parent's tag follow it. No state is edited. It is
 * still a cloud write, and behold never makes one: this module reads the
 * plan, runs the tool's own `-dry-run` for the preview, hands back the lines
 * with copy buttons, and reads the listing afterwards for the receipt. There
 * is no `/api/choudoufu/mv`, for the reason there is no `/api/carve/apply`
 * (AGENTS.md, "Invariant"), and `dryRunArgs` is the only way this module
 * spells `live-mv` — always with `-dry-run`, asserted by test.
 *
 * The plan is the live-mv workbench's `carve.json` (`tlmig/carve.py`):
 * `{from, estates[], moves[{address, from, to, new_address?}], rules?}`.
 * `rules` are how the rows were filled and are informational; `moves` is
 * what the executor acts on, and what this reads.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { captureChoudoufu, readLiveCheck, type Captured, type ChoudoufuRefusal } from "./choudoufu-member.ts";
import { parseLiveLs, type Runner } from "./choudoufu-live.ts";

/** `refusal.code`, pinned (choudoufu `internal/live/mv/refusal.go`). A refusal
 * outside these five carries an empty code and prose. */
export const REFUSAL_CODES = ["nothing_at_old_address", "two_at_old_address", "new_address_claimed", "destination_not_declared", "plan_changes_more_than_tags"] as const;

export interface CarvePlanMove {
  address: string;
  from: string;
  to: string;
  new_address?: string;
}

export interface CarvePlan {
  from: string;
  estates: string[];
  moves: CarvePlanMove[];
  rules?: unknown[];
}

export type CarvePlanParse = { ok: true; plan: CarvePlan } | { ok: false; refusal: ChoudoufuRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const refuse = (error: string, remedy: string): { ok: false; refusal: ChoudoufuRefusal } => ({ ok: false, refusal: { error, code: "choudoufu-live-check", remedy } });
const HOW_TO_GET_ONE = "A plan is the live-mv workbench's carve.json: `{from, estates[], moves[{address, from, to}]}` — the workbench's plan phase writes one, or write it by hand.";

/** Validate an already-parsed value as a move plan. Shallow: `moves[]` with
 * string `address`, `from`, `to`; `from` and `estates` as the workbench
 * writes them; `rules` ignored. */
export function parseCarvePlan(value: unknown): CarvePlanParse {
  if (!isRecord(value)) return refuse("That file is not a move plan — its top level is not a JSON object.", HOW_TO_GET_ONE);
  if (!Array.isArray(value.moves)) return refuse("That JSON is not a move plan — it has no `moves` array.", HOW_TO_GET_ONE);
  const bad = (value.moves as unknown[]).findIndex((m) => !isRecord(m) || typeof m.address !== "string" || typeof m.from !== "string" || typeof m.to !== "string");
  if (bad >= 0) return refuse(`moves[${bad}] is not a move (needs string \`address\`, \`from\` and \`to\`).`, HOW_TO_GET_ONE);
  const moves = value.moves as CarvePlanMove[];
  return {
    ok: true,
    plan: {
      from: typeof value.from === "string" ? value.from : (moves[0]?.from ?? ""),
      estates: Array.isArray(value.estates) ? value.estates.filter((e): e is string => typeof e === "string") : [...new Set(moves.map((m) => m.to))],
      moves,
      ...(Array.isArray(value.rules) ? { rules: value.rules } : {}),
    },
  };
}

/** Read and parse a plan file, refusing politely on anything unreadable. */
export function readCarvePlan(path: string, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): CarvePlanParse {
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    return refuse(`Couldn't read ${path}: ${err instanceof Error ? err.message : String(err)}`, HOW_TO_GET_ONE);
  }
  try {
    return parseCarvePlan(JSON.parse(text));
  } catch (err) {
    return refuse(`${path} is not JSON: ${err instanceof Error ? err.message : String(err)}`, HOW_TO_GET_ONE);
  }
}

/** `carve.json` at a member's root, when there is one — the workbench writes
 * it into the run directory, and a hand-written plan lives beside the
 * estate it moves. Relative to `base` so the SPA can pass it back as
 * `?plan=` and the route can resolve it inside the served members again. */
export function discoverCarvePlans(memberDirs: readonly string[], base: string): string[] {
  const out: string[] = [];
  for (const dir of memberDirs) {
    const p = join(dir, "carve.json");
    if (existsSync(p)) out.push(relative(base, p));
  }
  return out;
}

// ---------------------------------------------------------------------------
// live-mv's document.
// ---------------------------------------------------------------------------

export interface LiveMvEndpoint {
  estate?: string;
  address: string;
  marker?: string;
}

export interface LiveMvDocument {
  resource: { type: string; live_id: string; display_name?: string };
  from: LiveMvEndpoint;
  to: LiveMvEndpoint;
  followers?: { address: string; type: string }[];
  dry_run: boolean;
  written: boolean;
  verified: boolean;
  found_by?: string;
  request_id?: string;
  refusal?: { code?: string; summary: string; detail: string };
}

export type LiveMvParse = { ok: true; doc: LiveMvDocument } | { ok: false; refusal: ChoudoufuRefusal };

/** One document on every outcome, a refusal included (exit 1 with a
 * document) — which is what makes `-dry-run` usable as a preview. Empty
 * stdout is the one case that is not a document: an argument error before
 * the tool ran, or no binary. */
export function parseLiveMv(run: Captured, what: string): LiveMvParse {
  if (run.code === 127) return refuse("choudoufu is not on PATH.", "Install choudoufu and put it on PATH.");
  const text = run.stdout.trim();
  if (!text) return refuse(`choudoufu live-mv printed no document for ${what} (exit ${run.code}).`, "Run the line by hand to see choudoufu's own words.");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return refuse(`choudoufu live-mv printed something that is not JSON for ${what}.`, "Run the line by hand to see choudoufu's own words.");
  }
  if (!isRecord(json) || !isRecord(json.from) || !isRecord(json.to) || typeof json.dry_run !== "boolean") {
    return refuse(`That is not a live-mv document (${what}).`, "Upgrade choudoufu to 0.16.0 or newer.");
  }
  return { ok: true, doc: json as unknown as LiveMvDocument };
}

// ---------------------------------------------------------------------------
// The handoff.
// ---------------------------------------------------------------------------

/** A served choudoufu member the plan can name: its composed name, its
 * directory, and the estate its `live` block declares. */
export interface MoveMember {
  name: string;
  dir: string;
  estate: string;
}

/** The line a human runs, in the DESTINATION estate's directory. `live-mv`
 * with `-from-estate` finds the object under the source estate's tag and the
 * old address, and rewrites both markers to this configuration's estate and
 * the new address (the same address, for a plain move). */
export function handoffLine(m: CarvePlanMove): string {
  return `choudoufu live-mv -from-estate=${m.from} ${m.address} ${m.new_address ?? m.address}`;
}

/** The ONLY spelling of `live-mv` this module runs: the preview. `-dry-run`
 * is not an option here, it is the argument list. */
export function dryRunArgs(m: CarvePlanMove): string[] {
  return ["live-mv", "-json", "-dry-run", `-from-estate=${m.from}`, m.address, m.new_address ?? m.address];
}

/** What the morph takes per move (src/render.ts `renderMoveMorph`). */
export interface MoveMorphMoveInput {
  address: string;
  from: string;
  to: string;
  newAddress?: string;
  followers?: string[];
}

export interface MovePreview {
  address: string;
  from: string;
  to: string;
  newAddress?: string;
  /** The destination member, when the estate `to` names is served here. */
  destination?: { member: string; dir: string };
  /** The source member, when the estate `from` names is served here. */
  source?: { member: string };
  /** The handoff line, and where to run it. */
  command: string;
  runIn: string;
  /** `live-mv -json -dry-run`'s own document, when asked for and the
   * destination is a member; a refusal is a document too. */
  dryRun?: LiveMvDocument | { refusal: ChoudoufuRefusal };
}

export interface MovesPayload {
  plan: { from: string; estates: string[]; moves: number; rules: number };
  moves: MovePreview[];
  /** The apply boundary, restated on the wire so an agent reading this sees
   * it without reading the source. There is no endpoint to pair it with. */
  apply: { human: true; note: string };
}

export const MV_IS_HUMAN =
  "Each line is one tag write through choudoufu's own `live-mv`, run by a person in the destination estate's directory. behold previews with `-dry-run`, shows the lines, and reads the listing afterwards; it never runs the write.";

/** Resolve the served choudoufu members' estate names, from each one's own
 * `live-check` document (offline). A member whose document has none, or
 * cannot be read, is simply not a destination. */
export async function moveMembers(members: readonly { name: string; dir: string }[], run: Runner = captureChoudoufu): Promise<MoveMember[]> {
  const out: MoveMember[] = [];
  for (const m of members) {
    const parsed = await readLiveCheck(m.dir, run);
    if (parsed.ok && parsed.doc.estate) out.push({ name: m.name, dir: m.dir, estate: parsed.doc.estate });
  }
  return out;
}

/** The plan as the panel and the morph read it: one preview per move, the
 * handoff line for each, the dry-run document when asked. */
export async function movesPayload(plan: CarvePlan, members: readonly MoveMember[], opts: { dryRun?: boolean; run?: Runner } = {}): Promise<MovesPayload> {
  const run = opts.run ?? captureChoudoufu;
  const byEstate = new Map(members.map((m) => [m.estate, m] as const));
  const moves: MovePreview[] = [];
  for (const m of plan.moves) {
    const dest = byEstate.get(m.to);
    const src = byEstate.get(m.from);
    const preview: MovePreview = {
      address: m.address,
      from: m.from,
      to: m.to,
      ...(m.new_address ? { newAddress: m.new_address } : {}),
      ...(dest ? { destination: { member: dest.name, dir: dest.dir } } : {}),
      ...(src ? { source: { member: src.name } } : {}),
      command: handoffLine(m),
      runIn: dest ? dest.dir : `the ${m.to} estate's directory (not served here)`,
    };
    if (opts.dryRun && dest) {
      const parsed = parseLiveMv(await run(dryRunArgs(m), dest.dir), `${m.address} → ${m.to}`);
      preview.dryRun = parsed.ok ? parsed.doc : { refusal: parsed.refusal };
    }
    moves.push(preview);
  }
  return {
    plan: { from: plan.from, estates: plan.estates, moves: plan.moves.length, rules: plan.rules?.length ?? 0 },
    moves,
    apply: { human: true, note: MV_IS_HUMAN },
  };
}

// ---------------------------------------------------------------------------
// The receipt.
// ---------------------------------------------------------------------------

export interface MoveReceipt {
  /** Per estate the plan names: the addresses the account now lists under
   * its tag (`live-ls -consistent`), or why it could not be listed. */
  estates: Record<string, { addresses: string[] } | { error: string }>;
  /** Per move: where the account says the address is now. */
  moves: Array<{ address: string; to: string; newAddress?: string; state: "moved" | "pending" | "unknown" }>;
}

/** After a human ran the lines: the listing on every estate the plan names,
 * `-consistent` because the tagging index lags a write by about a minute
 * and this is exactly the read right after one. What the account says, not
 * what the plan said. */
export async function moveReceipt(plan: CarvePlan, members: readonly MoveMember[], run: Runner = captureChoudoufu): Promise<MoveReceipt> {
  const estates: MoveReceipt["estates"] = {};
  const wanted = new Set([plan.from, ...plan.estates, ...plan.moves.flatMap((m) => [m.from, m.to])].filter(Boolean));
  for (const estate of wanted) {
    const member = members.find((m) => m.estate === estate);
    if (!member) {
      estates[estate] = { error: "not served here" };
      continue;
    }
    const parsed = parseLiveLs(await run(["live-ls", `-estate=${estate}`, "-consistent", "-json", "."], member.dir), member.dir);
    estates[estate] = parsed.ok ? { addresses: parsed.doc.items.flatMap((i) => (i.address ? [i.address] : [])) } : { error: parsed.refusal.error };
  }
  const listed = (estate: string, address: string): boolean | undefined => {
    const e = estates[estate];
    return e && "addresses" in e ? e.addresses.includes(address) : undefined;
  };
  return {
    estates,
    moves: plan.moves.map((m) => {
      const target = m.new_address ?? m.address;
      const there = listed(m.to, target);
      const still = listed(m.from, m.address);
      const state = there === true ? "moved" : still === true ? "pending" : "unknown";
      return { address: m.address, to: m.to, ...(m.new_address ? { newAddress: m.new_address } : {}), state };
    }),
  };
}
