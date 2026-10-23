/**
 * Cards of one kind, stacked (#877).
 *
 * Ten security groups side by side in a box say "ten" less clearly than one
 * card that says "×10". So, under `?alike=1`:
 *
 * - within one box, three or more cards of the same kind become ONE card,
 *   titled with the kind and the count, wearing the kind's icon. Edges that
 *   touched any of them re-point at the stack, and two that now say the same
 *   thing draw once;
 * - a card that many others merely refer to (five or more, none of them on the
 *   traffic path) keeps the number and drops the lines: `used by 7`. The lines
 *   that carry traffic stay, whatever the count.
 *
 * Opening a stack is the inspect pane's job: the stack card carries its cards
 * (`_stackOf`), and the pane lists them. Turning the lens off draws them all.
 *
 * A sibling of the collapse lens (./collapse-lens.ts), which shuts a whole box;
 * this one leaves every box open and shortens what is inside it.
 */
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";
import { isWired } from "../web/edge-weight.js";
import { SUMMARY_LEXICON, summaryStatus } from "./collapse-lens.ts";
import { CHOUDOUFU_LEXICON } from "./choudoufu-member.ts";
import { TERRAFORM_LEXICON } from "./terraform-lens.ts";

/** Lexicons whose cards are titled from `attrs.address` (./card-face.ts). */
const ADDRESS_TITLED = new Set<string>([CHOUDOUFU_LEXICON, TERRAFORM_LEXICON]);

/** Cards of one kind in one box that stack. Two side by side read fine. */
export const STACK_MIN = 3;

/** References from this many cards or more, none of them traffic, turn into a count. */
export const HUB_MIN = 5;

/** The attr a stack card lists its cards under, for the inspect pane. */
export const STACK_OF = "_stackOf";

/** The attr a card that many refer to carries the count under. */
export const USED_BY = "_usedBy";

/** The last word of a kind: `AWS::EC2::SecurityGroup` → `SecurityGroup`, `Microsoft.Network/networkSecurityGroups` → `networkSecurityGroups`. */
export function shortKind(kind: string): string {
  return kind.split(/::|\//).filter(Boolean).pop() ?? kind;
}

export interface StackResult {
  ir: GraphIR;
  /** How many cards went into stacks, and how many stacks they made. */
  stacked: number;
  stacks: number;
  /** Cards that carry a count instead of their lines. */
  hubs: number;
}

/** A card whose plan read (#910) says the next apply changes it. */
function plannedChange(n: IRNode): boolean {
  const p = n.attrs?._plan as { source?: unknown; action?: unknown } | undefined;
  return !!p && p.source === "plan" && typeof p.action === "string" && p.action !== "no-op" && p.action !== "read";
}

/** Plain references: not a CI edge, and not the traffic path. */
function mereReference(e: IREdge): boolean {
  return (!e.kind || e.kind === "ref") && !isWired(e);
}

/**
 * Stack alike cards and turn crowded references into counts. Pure: `ir` is not
 * mutated, and a graph with nothing to stack or count comes back as the same
 * object.
 *
 * The box a card is in is its `groups.byStack` box when the graph has them (an
 * estate's members), and the whole graph otherwise.
 */
export function stackAlike(ir: GraphIR, opts: { min?: number; hubMin?: number } = {}): StackResult {
  const min = opts.min ?? STACK_MIN;
  const hubMin = opts.hubMin ?? HUB_MIN;
  const byStack = (ir.groups.byStack ?? {}) as Record<string, string[]>;
  const boxOf = new Map<string, string>();
  for (const [box, ids] of Object.entries(byStack)) for (const id of ids) if (!boxOf.has(id)) boxOf.set(id, box);

  // Box, lexicon and kind make an alike set. A summary card (the collapse lens)
  // and a folded composite (detail 1) already stand for several and don't stack.
  const sets = new Map<string, IRNode[]>();
  for (const n of ir.nodes) {
    if (!n.kind || n.lexicon === SUMMARY_LEXICON || typeof n.attrs?.members === "number") continue;
    // #910: a card the plan would change keeps its own face, so its plan rows
    // (what the apply does, what forces a replace) stay on the canvas.
    if (plannedChange(n)) continue;
    const key = `${boxOf.get(n.id) ?? ""}\u0000${n.lexicon ?? ""}\u0000${n.kind}`;
    (sets.get(key) ?? sets.set(key, []).get(key)!).push(n);
  }

  const standsFor = new Map<string, string>();
  const stackNodes: IRNode[] = [];
  const taken = new Set(ir.nodes.map((n) => n.id));
  for (const [key, nodes] of sets) {
    if (nodes.length < min) continue;
    const [box, lexicon, kind] = key.split("\u0000") as [string, string, string];
    // The id is the card's title (pinhole titles from the id), so it says what
    // the stack is. The full kind is the fallback if two lexicons in one box
    // share a last word.
    let id = `${box ? `${box}/` : ""}${shortKind(kind)} ×${nodes.length}`;
    if (taken.has(id)) id = `${box ? `${box}/` : ""}${kind} ×${nodes.length}`;
    taken.add(id);
    for (const n of nodes) standsFor.set(n.id, id);
    const status = summaryStatus(nodes);
    stackNodes.push({
      id,
      kind,
      lexicon: lexicon || undefined,
      attrs: {
        [STACK_OF]: nodes.map((n) => ({ id: n.id, ...(typeof n.attrs?._status === "string" ? { status: n.attrs._status } : {}) })),
        // terraform and choudoufu cards are titled from `address`, not the id.
        ...(ADDRESS_TITLED.has(lexicon) ? { address: `${shortKind(kind)} ×${nodes.length}` } : {}),
        ...(status ? { _status: status } : {}),
      },
    } as IRNode);
  }

  let edges: IREdge[] = ir.edges;
  if (standsFor.size) {
    const seen = new Set<string>();
    edges = [];
    for (const e of ir.edges) {
      const from = standsFor.get(e.from) ?? e.from;
      const to = standsFor.get(e.to) ?? e.to;
      if (from === to) continue;
      const k = `${from}|${to}|${e.kind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push(from === e.from && to === e.to ? e : { ...e, from, to });
    }
  }

  // Hubs: count the distinct cards that merely refer to each one.
  const referrers = new Map<string, Set<string>>();
  for (const e of edges) if (mereReference(e)) (referrers.get(e.to) ?? referrers.set(e.to, new Set()).get(e.to)!).add(e.from);
  const hubs = new Map<string, number>();
  for (const [to, from] of referrers) if (from.size >= hubMin) hubs.set(to, from.size);
  if (hubs.size) edges = edges.filter((e) => !(hubs.has(e.to) && mereReference(e)));

  if (!standsFor.size && !hubs.size) return { ir, stacked: 0, stacks: 0, hubs: 0 };

  const mark = (n: IRNode): IRNode => (hubs.has(n.id) ? { ...n, attrs: { ...n.attrs, [USED_BY]: hubs.get(n.id) } } : n);
  const nodes = [...ir.nodes.filter((n) => !standsFor.has(n.id)), ...stackNodes].map(mark);
  const groups = { ...ir.groups };
  if (ir.groups.byStack && standsFor.size) {
    groups.byStack = Object.fromEntries(
      Object.entries(byStack).map(([box, ids]) => [box, [...new Set(ids.map((id) => standsFor.get(id) ?? id))]]),
    );
  }
  return { ir: { ...ir, nodes, edges, groups }, stacked: standsFor.size, stacks: stackNodes.length, hubs: hubs.size };
}

/** The note a stacked view carries. Undefined when nothing changed. */
export function stackNote(r: Pick<StackResult, "stacked" | "stacks" | "hubs">): string | undefined {
  const parts: string[] = [];
  if (r.stacks) parts.push(`${r.stacked} cards stacked into ${r.stacks}`);
  if (r.hubs) parts.push(`${r.hubs} ${r.hubs === 1 ? "card carries" : "cards carry"} a count instead of its lines`);
  return parts.length ? `alike: ${parts.join(", ")} (click a stack to see its cards)` : undefined;
}

/** The rows a stacked card or a counted card adds to its face. */
export function stackFields(attrs: Record<string, unknown>): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const of = attrs[STACK_OF];
  if (Array.isArray(of)) out.push({ label: "stack", value: `${of.length} cards` });
  const used = attrs[USED_BY];
  if (typeof used === "number") out.push({ label: "used by", value: `${used} cards` });
  return out;
}
