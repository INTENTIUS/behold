/**
 * The apply order, as a graph (#426).
 *
 * chant computes a cross-stack apply-ordering graph while it resolves
 * cross-lexicon references, and states its own posture about it: "chant exposes
 * the order; it does not drive the apply." behold read neither it nor
 * `deployOrder`, and re-derived a subset — so a mixed estate drew every
 * substrate as though they all applied at once, which on chant's own
 * `gitlab-cells` example is false: helm must go after k8s, and the entity IR
 * behold reads for that project carries zero edges to say so with.
 *
 * This module is what `src/ops-lens.ts` is for an op.json and `src/carve-lens.ts`
 * is for a peelability report: a pure conversion into the `GraphIR` the existing
 * painter and SPA already draw. No new frontend, and the read is chant's.
 *
 * What the picture says:
 *
 *  - one card per STACK, which is a lexicon partition — `kind` is the lexicon
 *    name so pinhole's keyword glyph heuristic resolves `aws`, `k8s`, `helm`
 *    the way it does everywhere else, and `lexicon` is behold's own
 *    {@link STACK_LEXICON} so the card leads with its wave rather than with the
 *    alphabetically first attr;
 *  - one boundary box per wave (`groups.byStack`), in apply order, since a
 *    wave's stacks have no inter-dependency and go out together;
 *  - one edge per declared dependency, consumer to producer, which is the
 *    direction chant states it in.
 *
 * ---------------------------------------------------------------------------
 * A CYCLE IS NOT A REFUSAL. chant exits 1 when `cycles` is non-empty and the
 * entangled stacks are then absent from `order` and `waves` — a partial answer
 * about a real estate, not a failed read. src/zoom-notes.ts draws exactly this
 * line: a `RouteError` "replaces the canvas with a card, and is for a view that
 * could not be produced at all", while these views "were produced and are
 * honest; they just need a caption". So the cycle members are drawn in their
 * own box, unwaved, and the note says so. Nothing here invents a wave number
 * for a stack chant could not order — that would be the arbitrary order the
 * whole read exists to replace.
 * ---------------------------------------------------------------------------
 */
import type { GraphIR } from "@intentius/chant";
import type { StackGraph } from "./chant.ts";

/** behold's own lexicon for these cards, so `registerPack` can pin what they
 * lead with. Not a chant lexicon: a card here IS a lexicon, and titling it with
 * one would make the pack's own dispatch ambiguous. */
export const STACK_LEXICON = "stack-order";

/** The box a stack chant could not order sits in. */
export const CYCLE_BOX = "cycle — chant could not order these";

const waveBox = (i: number): string => `wave ${i + 1}`;

/**
 * The apply order as an IR. Pure, and total: an estate with one stack and no
 * edges is a legitimate one-card picture, which is what every example bundled
 * with behold actually produces.
 */
export function stackOrderToIr(graph: StackGraph): GraphIR {
  const inCycle = new Set(graph.cycles.flat());
  const waveOf = new Map<string, string>();
  graph.waves.forEach((wave, i) => wave.forEach((stack) => waveOf.set(stack, waveBox(i))));

  const nodes = graph.nodes.map((stack) => {
    const wave = waveOf.get(stack);
    return {
      id: stack,
      kind: stack,
      lexicon: STACK_LEXICON,
      attrs: {
        // The wave a reader wants on the card, and the position within the
        // flat order for a tie. A cycle member has neither, and says which.
        ...(wave ? { wave } : { wave: "unordered" }),
        ...(inCycle.has(stack) ? { cycle: true } : {}),
        ...(graph.order.includes(stack) ? { position: graph.order.indexOf(stack) + 1 } : {}),
      },
    };
  });

  // consumer -> producer, chant's own direction. `viaAttr` names the relation
  // so the inspect pane says what the edge means rather than just that it is.
  const edges = graph.edges.map((e) => ({ from: e.from, to: e.to, kind: "ref", viaAttr: "applies-after" }));

  const byStack: Record<string, string[]> = {};
  for (const node of nodes) {
    const box = inCycle.has(node.id) ? CYCLE_BOX : (waveOf.get(node.id) ?? CYCLE_BOX);
    (byStack[box] ??= []).push(node.id);
  }

  return { nodes, edges, groups: { byStack } } as unknown as GraphIR;
}

/**
 * Why this picture looks the way it does.
 *
 * Load-bearing rather than decoration: every example bundled with behold
 * returns one wave and no edges, so without a line saying "no cross-lexicon
 * references here" the lens reads as broken on exactly the projects a first-
 * time reader opens.
 */
export function stackOrderNote(graph: StackGraph): string | undefined {
  if (graph.nodes.length === 0) return "no stacks — this project declares no lexicon partitions to order";
  const parts: string[] = [];
  const waves = graph.waves.length;
  parts.push(
    graph.nodes.length === 1
      ? "1 stack — nothing to order against"
      : `${graph.nodes.length} stacks in ${waves} ${waves === 1 ? "wave" : "waves"}`,
  );
  if (graph.edges.length === 0 && graph.nodes.length > 1) {
    parts.push("no cross-lexicon references, so every stack is independent and they apply together");
  } else if (graph.edges.length) {
    parts.push(`${graph.edges.length} ${graph.edges.length === 1 ? "dependency" : "dependencies"}, consumer to producer`);
  }
  if (graph.cycles.length) {
    const members = graph.cycles.flat();
    parts.push(`${members.length} in a cycle chant could not order (${members.join(", ")}) — drawn unwaved, and chant exits non-zero on it`);
  }
  return parts.join("; ");
}

/** The short form for the 260px strip, on the same rule the Terraform note
 * follows: the server writes both, the SPA truncates neither. */
export function stackOrderNoteShort(graph: StackGraph): string | undefined {
  if (graph.nodes.length === 0) return "no stacks";
  const bits = [`${graph.nodes.length} stack${graph.nodes.length === 1 ? "" : "s"}`, `${graph.waves.length} wave${graph.waves.length === 1 ? "" : "s"}`];
  if (graph.edges.length) bits.push(`${graph.edges.length} dep${graph.edges.length === 1 ? "" : "s"}`);
  if (graph.cycles.length) bits.push(`${graph.cycles.flat().length} in a cycle`);
  return bits.join(" · ");
}
