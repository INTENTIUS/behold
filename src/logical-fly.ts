/**
 * Fly logical projection (behold#167) — the seventh topology lens:
 *
 *   app <name> ⊃ the app's machines, volumes, IPs and certificates
 *
 * Fly's topology unit is the app: machines run in it, volumes attach inside
 * it, IPs and certs hang off it. But the source graph never says so — a
 * `Fly::Machines::Machine` declaration carries no app field at all, because
 * the flaps API scopes every request by app *path segment* and chant's fly
 * serializer resolves the owner at deploy time. So membership here follows
 * the exact convention the fly lexicon's own `describe-resources` uses:
 *
 *   1. a declared `$ref` (or IR edge) from the resource to an app wins;
 *   2. an estate declaring exactly ONE app owns everything (the "sole app"
 *      rule — the serializer resolves the same way);
 *   3. more than one app and no ref: the card stays at the root. A root
 *      card beats a guessed home, same posture as `nestReleaseBoxes`.
 *
 * The app card sits inside its own box (the helm lens's chart-card idiom),
 * so live-overlay status colouring on the app survives the projection.
 * Region is deliberately not a box: `region` is usually `Fly.Region` — an
 * intrinsic resolved from FLY_REGION at deploy — so a source graph carries a
 * placeholder, not a value, and a lane that exists only when someone pins a
 * literal would come and go confusingly. It stays an inspect-panel fact.
 *
 * Secrets are dropped from the picture (config, not topology — and a shared
 * secret referenced by half the app would only ever be a hub). Edges are
 * pass-through plus `$ref`-derived between surviving cards (a machine mount
 * referencing its volume); no contraction — there is nothing to contract
 * through on this lexicon.
 */
import type { GraphIR, IRNode, IREdge } from "@intentius/chant";
import type { LogicalProjection, ByContainer } from "./logical.ts";

/** The box title for a fly app. */
export function appBoxTitle(appName: string): string {
  return `app ${appName}`;
}

const APP_KIND = "Fly::Machines::App";

/** The resources a fly picture shows. Everything else (secrets, the config
 * composites) is plumbing. */
const FLY_CARD_KINDS = new Set([
  APP_KIND,
  "Fly::Machines::Machine",
  "Fly::Machines::Volume",
  "Fly::Machines::IPAddress",
  "Fly::Machines::Certificate",
]);

/** The app name an App node declares, falling back to the node id — an
 * unnamed box beats a dropped app. */
function appNameOf(node: IRNode): string {
  const name = node.attrs?.name;
  return typeof name === "string" && name.length > 0 ? name : node.id;
}

/** Deep-collect the node ids a value references via `{$ref:"node.attr"}`. */
function collectRefs(v: unknown, out: Set<string>): void {
  if (!v || typeof v !== "object") return;
  const ref = (v as { $ref?: unknown }).$ref;
  if (typeof ref === "string") out.add(ref.split(".")[0]);
  for (const key of Object.keys(v as Record<string, unknown>)) collectRefs((v as Record<string, unknown>)[key], out);
}

export function projectFlyLogical(ir: GraphIR): LogicalProjection {
  const fly = ir.nodes.filter((n) => n.lexicon === "fly");
  if (fly.length === 0) return { ir: { nodes: [], edges: [], groups: {} }, byContainer: {} };

  const cards = fly.filter((n) => FLY_CARD_KINDS.has(n.kind));
  const apps = cards.filter((n) => n.kind === APP_KIND);
  const appIds = new Set(apps.map((n) => n.id));
  const kept = new Set(cards.map((n) => n.id));

  // Outward references per card: `$ref`s in its own attrs plus the IR's edges.
  // A node's attrs also `$ref` its OWN deploy-time readonly attributes
  // (`{$ref:"web.checks"}` on `web` itself), so self-refs are dropped.
  const refOut = new Map<string, Set<string>>();
  const addRef = (from: string, to: string) => {
    if (from === to) return;
    (refOut.get(from) ?? refOut.set(from, new Set()).get(from)!).add(to);
  };
  for (const n of fly) {
    const refs = new Set<string>();
    collectRefs(n.attrs, refs);
    for (const r of refs) addRef(n.id, r);
  }
  for (const e of ir.edges) addRef(e.from, e.to);

  const byContainer: ByContainer = {};
  const child = (parent: string, c: string) => {
    const arr = byContainer[parent] ?? (byContainer[parent] = []);
    if (!arr.includes(c)) arr.push(c);
  };

  // Every declared app is a box holding its own card, even when nothing else
  // resolves into it — a declared app is a fact about the estate.
  const boxOf = new Map<string, string>();
  for (const app of apps) {
    const box = appBoxTitle(appNameOf(app));
    boxOf.set(app.id, box);
    child(box, app.id);
  }

  // Membership: declared ref first, sole app second, root otherwise.
  const soleApp = apps.length === 1 ? apps[0].id : undefined;
  for (const n of cards) {
    if (appIds.has(n.id)) continue;
    const referenced = [...(refOut.get(n.id) ?? [])].find((r) => appIds.has(r));
    const owner = referenced ?? soleApp;
    if (owner) child(boxOf.get(owner)!, n.id);
  }

  // Pass-through and `$ref`-derived edges between surviving cards, deduped
  // undirected. App-membership refs stay containment (the boxes), not edges.
  const edges: IREdge[] = [];
  const seen = new Set<string>();
  for (const [from, tos] of refOut) {
    if (!kept.has(from)) continue;
    for (const to of tos) {
      if (!kept.has(to) || appIds.has(from) || appIds.has(to)) continue;
      const key = from < to ? `${from}|${to}` : `${to}|${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to, kind: "ref" });
    }
  }

  return { ir: { nodes: cards, edges, groups: {} }, byContainer };
}
