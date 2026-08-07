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

/** Directory of a node's declaring file, "" when unknown. */
function dirOf(node: { sourceLoc?: { file?: string } }): string {
  const file = node.sourceLoc?.file;
  if (typeof file !== "string") return "";
  const slash = file.lastIndexOf("/");
  return slash >= 0 ? file.slice(0, slash) : "";
}

/** The nearest ancestor dir (self included) carrying a kustomization file,
 * resolved against `projectDir`; undefined when none. Walks at most four
 * levels — a kustomization root is near its resources by design. */
function kustomizationRoot(projectDir: string, dir: string, exists: (p: string) => boolean): string | undefined {
  let current = dir;
  for (let i = 0; i < 4 && current; i++) {
    if (exists(join(projectDir, current, "kustomization.yaml")) || exists(join(projectDir, current, "kustomization.yml"))) {
      return current;
    }
    const slash = current.lastIndexOf("/");
    current = slash >= 0 ? current.slice(0, slash) : "";
  }
  return undefined;
}

export function projectKustomizeLogical(
  ir: GraphIR,
  projectDir: string,
  exists: (p: string) => boolean = existsSync,
): LogicalProjection {
  const k8s = ir.nodes.filter((n) => n.lexicon === "k8s");
  if (k8s.length === 0) return { ir: { nodes: [], edges: [], groups: {} }, byContainer: {} };

  const byContainer: ByContainer = {};
  const child = (parent: string, c: string) => {
    const arr = byContainer[parent] ?? (byContainer[parent] = []);
    if (!arr.includes(c)) arr.push(c);
  };

  const rootCache = new Map<string, string | undefined>();
  for (const n of k8s) {
    const dir = dirOf(n);
    if (dir === "") continue;
    if (!rootCache.has(dir)) rootCache.set(dir, kustomizationRoot(projectDir, dir, exists));
    const root = rootCache.get(dir);
    if (root === undefined) continue;
    const name = root.split("/").pop() || root;
    child(overlayBoxTitle(name), n.id);
  }

  // Membership only — no cards of this lens's own (see the module doc).
  return { ir: { nodes: [], edges: [], groups: {} }, byContainer };
}
