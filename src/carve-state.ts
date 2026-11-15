/**
 * A carve's state as the views paint it (#230 M3): the stage a manifest adds up
 * to, the word and tone a card shows for it, the progress read, and the split
 * of a Terraform ranking against the states. src/carve-manifest.ts reads the
 * manifests from disk and re-exports all of this; it lives here, with no Node
 * imports, so the painter in src/render.ts bundles for a browser (#1069).
 */
import type { GraphIR, IRNode } from "@intentius/chant";

/** How far along a carve is. Cumulative — see the module comment. */
export type CarveStage = "emitted" | "bridged" | "applied";

/** How a stage paints. `accent` is the in-flight tone: an existing pinhole
 * status token, distinct from the three band tones (`good`/`warn`/`neutral`)
 * the ranking already spends, so a partly-carved card cannot be mistaken for a
 * band verdict. Both partial stages share it and are told apart by their WORD
 * ({@link carveWordFor}), which is on the card: a second tone would have to
 * borrow a token that already means something else in this picture, and tone
 * alone was never allowed to carry a state here anyway. */
export type CarveTone = "good" | "accent";

/** One carved address, flattened for rendering. */
export interface CarveState {
  target: string;
  tfType?: string;
  stage: CarveStage;
  /** True only at `applied`: chant owns it, so it draws in the chant box. */
  graduated: boolean;
  /** When the LAST recorded step ran (ISO 8601), when chant stamped one. */
  at?: string;
  /** Emitted chant source files, as the manifest records them — absolute in a
   * V1 manifest, relative to the manifest's own directory since chant 0.54.0
   * (chant#2039). */
  files: string[];
  /** The same files, resolved absolute against the manifest's directory — the
   * side of the chant#2040 join a graph node's `sourceLoc.file` is compared to. */
  sourceFiles: string[];
  /** Terraform blocks the bridge patch would remove. */
  excised: string[];
  /** Deferred deploy-time inputs the emit recorded, `<param> ← <survivor>`. */
  deferredInputs: string[];
  /** The ownership marker `carve apply` resolved. Present iff `applied`. */
  ownership?: { stack?: string; env?: string; tags?: Record<string, string> };
  /** The Terraform estate the carve came from, as the manifest recorded it. */
  from?: string;
  /** The `--output` dir this manifest sits in — where the later verbs compose. */
  outDir: string;
  /** Where the manifest was read from. */
  path: string;
}

/** The stage's word, as it reads on a card and in the panel. The word is the
 * state's carrier; the tone only reinforces it. */
export function carveWordFor(stage: CarveStage): string {
  switch (stage) {
    case "applied":
      return "carved → chant";
    case "bridged":
      return "bridged — apply is yours";
    default:
      return "emitted — not bridged";
  }
}

/** The stage's tone. See {@link CarveTone} for why both partial stages share
 * `accent`. */
export function carveToneFor(stage: CarveStage): CarveTone {
  return stage === "applied" ? "good" : "accent";
}


/** The strangler-fig progress read. `total` is the ranked-resource count from
 * the carve report when there is one; without a report there is no denominator
 * and the label says the numerator alone rather than inventing one. */
export interface CarveProgress {
  applied: number;
  bridged: number;
  emitted: number;
  /** Carves started but not graduated — the partial states. */
  inFlight: number;
  total: number | null;
  /** "1 of 12 carved" / "1 carved". */
  label: string;
  /** "1 emitted, 1 bridged — apply is yours", or "" when nothing is in flight. */
  detail: string;
}

export function carveProgress(states: Iterable<CarveState>, total?: number | null): CarveProgress {
  let applied = 0;
  let bridged = 0;
  let emitted = 0;
  for (const s of states) {
    if (s.stage === "applied") applied++;
    else if (s.stage === "bridged") bridged++;
    else emitted++;
  }
  const inFlight = bridged + emitted;
  const parts: string[] = [];
  if (emitted) parts.push(`${emitted} emitted`);
  if (bridged) parts.push(`${bridged} bridged`);
  return {
    applied,
    bridged,
    emitted,
    inFlight,
    total: typeof total === "number" ? total : null,
    label: typeof total === "number" ? `${applied} of ${total} carved` : `${applied} carved`,
    detail: parts.length ? `${parts.join(", ")} — apply is yours` : "",
  };
}

/**
 * Split a Terraform ranking against the manifest state.
 *
 * A graduated address leaves the TF bands entirely and comes back as a chant
 * node — it keeps its Terraform ADDRESS as its id (the morph's identity
 * continuity, #230 M2b, depends on that), and carries the ownership marker in
 * its attrs so the inspect pane can say who owns it and since when.
 *
 * A partial address stays in its band — nothing has changed hands — but its
 * card is repainted: the in-flight tone plus the stage's word in the `carve`
 * field the presentation pack already shows.
 *
 * Boundary edges to a graduated node are dropped along with it. The edge
 * described a cut that has now been made; drawing it would claim the survivor
 * still reads the Terraform resource, which after `carve bridge` + `apply` it
 * does not.
 */
export function splitCarveState(
  tfIr: GraphIR,
  states: Map<string, CarveState>,
  // The emitted source path lands on the card, and chant records it absolute.
  // `shorten` is how a caller trims it to something a viewer learns from —
  // `app/carveout/src/assets.ts` rather than the length of an operator's
  // tmpdir. Identity, not redaction: the same presentation choice
  // src/carve-actions.ts makes for every command it echoes.
  opts: { shorten?: (path: string) => string; emitted?: Map<string, IRNode> } = {},
): { tf: GraphIR; graduated: IRNode[] } {
  if (states.size === 0) return { tf: tfIr, graduated: [] };
  const shorten = opts.shorten ?? ((p: string) => p);
  // chant#2040: the chant node the carve actually emitted, when the emitted
  // project could be graphed. A graduated card keeps its Terraform address as
  // its id (the morph's identity continuity) and takes on the entity it
  // became — kind, lexicon, declared attrs, source location — so the card in
  // the chant box reads as chant source, not as a Terraform address wearing a
  // green fill. A partial carve only names the entity; nothing changed hands.
  const emitted = opts.emitted ?? new Map<string, IRNode>();
  const declaredAttrs = (n: IRNode): Record<string, unknown> =>
    Object.fromEntries(Object.entries(n.attrs ?? {}).filter(([k]) => !k.startsWith("_") && k !== "carved"));
  const source = (files: string[]): string => files.map(shorten).join(", ");
  const gone = new Set<string>();
  const graduated: IRNode[] = [];
  const nodes: IRNode[] = [];

  for (const node of tfIr.nodes) {
    const state = states.get(node.id);
    if (!state) {
      nodes.push(node);
      continue;
    }
    const became = emitted.get(node.id);
    if (state.graduated) {
      gone.add(node.id);
      graduated.push({
        ...node,
        ...(became ? { kind: became.kind, lexicon: became.lexicon, ...(became.sourceLoc ? { sourceLoc: became.sourceLoc } : {}) } : {}),
        attrs: {
          ...node.attrs,
          ...(became ? { ...declaredAttrs(became), chantEntity: `${became.kind} ${became.id}` } : {}),
          _status: "good",
          carve: carveWordFor(state.stage),
          carveState: state.stage,
          ...(state.ownership?.stack ? { ownedStack: state.ownership.stack } : {}),
          ...(state.ownership?.env ? { ownedEnv: state.ownership.env } : {}),
          ...(state.at ? { carvedAt: state.at } : {}),
          ...(state.files.length ? { chantSource: source(state.files) } : {}),
        },
      });
      continue;
    }
    nodes.push({
      ...node,
      attrs: {
        ...node.attrs,
        _status: carveToneFor(state.stage),
        carve: carveWordFor(state.stage),
        carveState: state.stage,
        ...(became ? { chantEntity: `${became.kind} ${became.id}` } : {}),
        ...(state.at ? { carvedAt: state.at } : {}),
        ...(state.files.length ? { chantSource: source(state.files) } : {}),
        ...(state.excised.length ? { excisesOnApply: state.excised.join(", ") } : {}),
        ...(state.deferredInputs.length ? { deferredInputs: state.deferredInputs.join(", ") } : {}),
      },
    });
  }

  const byStack: Record<string, string[]> = {};
  for (const [band, members] of Object.entries((tfIr.groups?.byStack ?? {}) as Record<string, string[]>)) {
    const left = members.filter((id) => !gone.has(id));
    if (left.length) byStack[band] = left;
  }

  return {
    tf: {
      nodes,
      edges: tfIr.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
      groups: { ...tfIr.groups, byStack },
    },
    graduated,
  };
}
