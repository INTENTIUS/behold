/**
 * Kustomize logical projection (behold#171) — the sixth topology lens:
 *
 *   overlay <name> ⊃ the k8s objects declared under a kustomization root
 *
 * The claim is by source directory, exactly the helm lens's rule
 * (logical-helm.ts): a node whose `sourceLoc` sits in (or beneath) a
 * directory carrying a `kustomization.yaml` belongs to that overlay. This
 * self-gates hard: an estate with no kustomization files anywhere near its
 * source projects empty and nothing changes — which is every estate until
 * chant#1548 piece 3 (kustomize build roots) or an import kept beside its
 * overlay produces graph nodes with kustomize provenance. Entity-level
 * rendering of kustomize-APPLIED objects (deploy-step estates, no typed
 * source) is deliberately not attempted here: those objects are not graph
 * nodes at all — that's chant's build-root piece, tracked on #1548.
 *
 * Membership only, possibly zero cards: unlike helm there is no
 * `Kustomize::*` node to be the box's card, and a `byContainer` key needs no
 * backing node (pinhole draws a titled box; since 0.2.5 even a childless one
 * is finite). The k8s NODES stay owned by the k8s lens — the composition
 * invariant every lens obeys.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import type { LogicalProjection, ByContainer } from "./logical.ts";

/** The box title for an overlay root. */
export function overlayBoxTitle(name: string): string {
  return `overlay ${name}`;
}

/** chant#1612 (chant 0.44.1, behold#217): the authoritative provenance —
 * chant's kustomize build roots stamp every emitted object with the root it
 * was built from. Preferred over the directory walk whenever present (the
 * upgrade behold#171's kustomize bullet reserved for exactly this attr), and
 * strictly more capable: it needs no sourceLoc and no kustomization file on
 * disk, so kustomize-APPLIED objects (deploy-step estates, the case the
 * module doc above defers) get their overlay box too. */
const ROOT_ANNOTATION = "chant.intentius.io/kustomize-root";
function annotatedRoot(node: { attrs?: Record<string, unknown> }): string | undefined {
  const metadata = node.attrs?.metadata as { annotations?: Record<string, unknown> } | undefined;
  const v = metadata?.annotations?.[ROOT_ANNOTATION];
  return typeof v === "string" && v ? v : undefined;
}

/** Directory of a node's declaring file, "" when unknown. */
function dirOf(node: { sourceLoc?: { file?: string } }): string {
  const file = node.sourceLoc?.file;
  if (typeof file !== "string") return "";
  const slash = file.lastIndexOf("/");
  return slash >= 0 ? file.slice(0, slash) : "";
}

/** The nearest ancestor dir (self included) carrying a kustomization file,
 * resolved against each base in turn; undefined when none. Walks at most four
 * levels — a kustomization root is near its resources by design. */
function kustomizationRoot(bases: string[], dir: string, exists: (p: string) => boolean): string | undefined {
  let current = dir;
  for (let i = 0; i < 4 && current; i++) {
    for (const base of bases) {
      if (exists(join(base, current, "kustomization.yaml")) || exists(join(base, current, "kustomization.yml"))) {
        return current;
      }
    }
    const slash = current.lastIndexOf("/");
    current = slash >= 0 ? current.slice(0, slash) : "";
  }
  return undefined;
}

/** `sourceRoots`: the directories `sourceLoc.file` may be relative to. chant
 * reports it relative to the path `chant graph` was invoked on — the resolved
 * `sourceDir` (`graphPath()`) on the declared path, but the PROJECT root on
 * the `--live` overlay path (which ignores the path positional and walks the
 * whole estate). An estate with `sourceDir: "src"` therefore yields
 * `overlay/dev/main.ts` from one endpoint and `src/overlay/dev/main.ts` from
 * the other; probing every base keeps the box in both views. The box title is
 * the root dir's basename either way, so the two shapes agree on the name. */
export function projectKustomizeLogical(
  ir: GraphIR,
  sourceRoots: string | string[],
  exists: (p: string) => boolean = existsSync,
): LogicalProjection {
  const bases = Array.isArray(sourceRoots) ? sourceRoots : [sourceRoots];
  const k8s = ir.nodes.filter((n) => n.lexicon === "k8s");
  if (k8s.length === 0) return { ir: { nodes: [], edges: [], groups: {} }, byContainer: {} };

  const byContainer: ByContainer = {};
  const child = (parent: string, c: string) => {
    const arr = byContainer[parent] ?? (byContainer[parent] = []);
    if (!arr.includes(c)) arr.push(c);
  };

  const rootCache = new Map<string, string | undefined>();
  for (const n of k8s) {
    // The stamped provenance wins (#217); the directory walk remains for
    // typed-source estates built by a chant predating #1612.
    let root = annotatedRoot(n);
    if (root === undefined) {
      const dir = dirOf(n);
      if (dir === "") continue;
      if (!rootCache.has(dir)) rootCache.set(dir, kustomizationRoot(bases, dir, exists));
      root = rootCache.get(dir);
    }
    if (root === undefined) continue;
    const name = root.replace(/\/+$/, "").split("/").pop() || root;
    child(overlayBoxTitle(name), n.id);
  }

  // Membership only — no cards of this lens's own (see the module doc).
  return { ir: { nodes: [], edges: [], groups: {} }, byContainer };
}
