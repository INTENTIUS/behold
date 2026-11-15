/**
 * behold#1080: chant's reference catalog, read from `chant workspace graph`.
 *
 * chant#5097 runs every lexicon's reference catalog over the composed nodes of
 * a workspace, so a reference can join two members. What it finds is on the
 * document the whole workspace read prints:
 *
 *  - `edges[]` carries a derived edge with `origin: "derived"`, the `rule` that
 *    drew it, `relation`, `grain` and `member`;
 *  - `dangling[]` a reference that names no node, now with `rule`, `targetKind`
 *    and, where there is one, `through` and `cluster`;
 *  - `ambiguous[]` a reference that names several, `{ from, member, rule, path,
 *    value, candidates }`, with no edge drawn;
 *  - `catalog.rules` each rule the document names, `{ lexicon, from, path,
 *    relation, targetKinds, label }`, keyed by its id.
 *
 * A read of one member (`--member <name>`, which is how behold reads each
 * member) runs the catalog over that member alone, so a reference into another
 * member comes back dangling. The reads here are the whole workspace's, once,
 * and what they find is put on the composed estate: the edges, the dangling and
 * ambiguous references and the rules, on `ir.catalog`. Its presence is what
 * says "chant's rules decided this picture", and everything that draws them
 * (src/catalog-draw.ts) and the cluster anchor (src/cluster-anchor.ts) asks it.
 *
 * Gated on {@link REFERENCE_CATALOG_CHANT_FLOOR}: a chant below it is never
 * sent the read, and the estate is composed as it always was.
 */
import type { GraphIR } from "@intentius/chant";
import { envOverridesFor, resolveChant, type GraphOptions } from "./chant.ts";
import { REFERENCE_CATALOG_CHANT_FLOOR } from "./chant-floors.ts";
import { meetsFloor } from "./floor.ts";
import { memberSourceStamp } from "./member-source.ts";
import { rootReader, type WorkspaceDocument } from "./workspace-reader.ts";

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export * from "./reference-catalog-shape.ts";
import type { CatalogAmbiguous, CatalogDangling, CatalogEdge, CatalogIr, CatalogRule, IrCatalog, ReferenceCatalog } from "./reference-catalog-shape.ts";

/** Rules from the document: the object keyed by id chant prints, or a list of `{ id, ... }`. */
function rulesOf(raw: unknown): Record<string, CatalogRule> {
  const out: Record<string, CatalogRule> = {};
  const entries: Array<[string | undefined, unknown]> = Array.isArray(raw) ? raw.map((r) => [isRecord(r) ? str(r.id) : undefined, r]) : isRecord(raw) ? Object.entries(raw) : [];
  for (const [key, r] of entries) {
    if (!isRecord(r)) continue;
    const id = key ?? str(r.id);
    if (!id) continue;
    out[id] = {
      id,
      lexicon: str(r.lexicon) ?? id.split(":")[0] ?? "",
      holderKind: str(r.holderKind) ?? str(r.from) ?? "",
      path: str(r.path) ?? "",
      relation: str(r.relation) ?? "reference",
      targetKinds: Array.isArray(r.targetKinds) ? r.targetKinds.filter((k): k is string => typeof k === "string") : [],
      label: str(r.label) ?? "",
    };
  }
  return out;
}

/**
 * The reference catalog a `workspace graph` document carries, or undefined
 * when it has none (a chant below the floor prints no `catalog`). Entries that
 * are not the shape chant#5097 documents are left out, never repaired.
 */
export function referenceCatalogOf(doc: WorkspaceDocument): ReferenceCatalog | undefined {
  if (!isRecord(doc.catalog)) return undefined;
  const rules = rulesOf(doc.catalog.rules);
  const edges: CatalogEdge[] = [];
  const runsOn: Array<{ from: string; to: string }> = [];
  for (const e of Array.isArray(doc.edges) ? doc.edges : []) {
    if (!isRecord(e) || !str(e.from) || !str(e.to)) continue;
    if (e.origin === "derived" && str(e.rule)) {
      edges.push({
        from: e.from as string,
        to: e.to as string,
        kind: str(e.kind) ?? "ref",
        rule: e.rule as string,
        ...(str(e.viaAttr) ? { viaAttr: e.viaAttr as string } : {}),
        ...(str(e.relation) ? { relation: e.relation as string } : {}),
        ...(str(e.grain) ? { grain: e.grain as string } : {}),
        ...(str(e.member) ? { member: e.member as string } : {}),
      });
    } else if (e.origin === "declared" && e.viaAttr === "runsOn") {
      runsOn.push({ from: e.from as string, to: e.to as string });
    }
  }
  const dangling: CatalogDangling[] = [];
  for (const d of Array.isArray(doc.dangling) ? doc.dangling : []) {
    if (!isRecord(d) || !str(d.from) || !str(d.rule) || typeof d.value !== "string") continue;
    dangling.push({
      from: d.from as string,
      path: str(d.path) ?? "",
      value: d.value,
      rule: d.rule as string,
      ...(str(d.targetKind) ? { targetKind: d.targetKind as string } : {}),
      ...(str(d.through) ? { through: d.through as string } : {}),
      ...(str(d.cluster) ? { cluster: d.cluster as string } : {}),
    });
  }
  const ambiguous: CatalogAmbiguous[] = [];
  for (const a of Array.isArray(doc.ambiguous) ? doc.ambiguous : []) {
    if (!isRecord(a) || !str(a.from) || !str(a.rule) || typeof a.value !== "string" || !Array.isArray(a.candidates)) continue;
    const candidates = a.candidates.filter((c): c is string => typeof c === "string");
    if (candidates.length < 2) continue;
    ambiguous.push({ from: a.from as string, ...(str(a.member) ? { member: a.member as string } : {}), rule: a.rule as string, path: str(a.path) ?? "", value: a.value, candidates });
  }
  return { ...(str(doc.chant) ? { chant: doc.chant as string } : {}), rules, edges, dangling, ambiguous, runsOn };
}

/** The edge that stands for a pair, for the one-edge-per-pair rule. */
const pairKey = (from: string, to: string): string => `${from}\0${to}`;

/**
 * Put what the catalog found on the composed estate. Mutates and returns `ir`.
 *
 *  - A derived edge between two cards of the estate is added. Where the pair
 *    already has an edge (behold's own join or an inferred one), that edge takes
 *    the rule: chant's exact match is the better account of the same line.
 *  - Entries of `ir.dangling` that carry a `rule` came from a read of one
 *    member, which cannot see another member's nodes, so they are dropped and
 *    the whole workspace's stand in their place. Dangling references with no
 *    `rule` (a CI workflow that calls another repository's) stay as they were.
 *  - The rules, and the dangling and ambiguous references of cards the estate
 *    draws, go on `ir.catalog`.
 */
export function applyReferenceCatalog(ir: GraphIR, catalog: ReferenceCatalog): GraphIR {
  const ids = new Set(ir.nodes.map((n) => n.id));
  const byPair = new Map<string, number>();
  ir.edges.forEach((e, i) => {
    if (!byPair.has(pairKey(e.from, e.to))) byPair.set(pairKey(e.from, e.to), i);
  });
  for (const e of catalog.edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    const at = byPair.get(pairKey(e.from, e.to));
    const stamp = { origin: "derived", rule: e.rule, ...(e.relation ? { relation: e.relation } : {}), ...(e.grain ? { grain: e.grain } : {}) };
    if (at !== undefined) {
      const mine = ir.edges[at] as unknown as Rec;
      // A declared edge is a statement; only a guess gives way to a rule.
      if (mine.origin === "declared" || (mine.inferred !== true && mine.origin !== "derived")) continue;
      Object.assign(mine, stamp, { inferred: true });
      delete mine.join;
      continue;
    }
    byPair.set(pairKey(e.from, e.to), ir.edges.length);
    ir.edges.push({ from: e.from, to: e.to, kind: e.kind as never, ...(e.viaAttr ? { viaAttr: e.viaAttr } : {}), inferred: true, ...stamp } as never);
  }
  const own = (id: string): boolean => ids.has(id);
  const dangling = catalog.dangling.filter((d) => own(d.from));
  const ambiguous = catalog.ambiguous.filter((a) => own(a.from));
  const held = ir as unknown as { dangling?: Array<Rec & { from: string }> };
  const kept = (held.dangling ?? []).filter((d) => typeof d.rule !== "string");
  const next = [...kept, ...dangling.map((d) => ({ ...d, kind: "ref" }))];
  if (next.length) held.dangling = next as never;
  else delete held.dangling;
  (ir as CatalogIr).catalog = { rules: catalog.rules, dangling, ambiguous, runsOn: catalog.runsOn.filter((r) => own(r.from) && own(r.to)) };
  return ir;
}

/** The estate-wide read: the workspace graph document at `detail`, cached under the workspace's source stamp. */
const documents = new Map<string, WorkspaceDocument>();
const DOCUMENT_CACHE = 8;

export function resetReferenceCatalogCache(): void {
  documents.clear();
}

export interface CatalogReadDeps {
  /** The reader for a workspace root. Default: chant, through the read contract. */
  read?: (root: string, args: string[], env?: Record<string, string>) => Promise<WorkspaceDocument>;
  /** The chant version of the workspace. Default: the one `resolveChant` finds. */
  chantVersion?: (root: string) => string | undefined;
}

/** What a read of the catalog came to. */
export type CatalogRead = { ok: true; catalog: ReferenceCatalog } | { ok: false; reason: "floor" | "none" | "error"; message?: string };

/**
 * Read the whole workspace's catalog. Sent only to a chant at the floor, and
 * through the same reader every workspace read uses. The tier is the one the
 * members are read at, so the ids the document names are the ids the composed
 * estate has (chant moves an edge to the node drawn at detail 1 and 0).
 */
export async function readReferenceCatalog(root: string, opts: GraphOptions & { chant?: string } = {}, deps: CatalogReadDeps = {}): Promise<CatalogRead> {
  const version = opts.chant ?? deps.chantVersion?.(root) ?? resolveChant(root).version;
  if (!meetsFloor(version, REFERENCE_CATALOG_CHANT_FLOOR)) return { ok: false, reason: "floor" };
  const args = [root, ...(opts.detail !== undefined ? ["--detail", String(opts.detail)] : []), ...(opts.env ? ["--env", opts.env] : [])];
  const env = envOverridesFor(opts);
  const stamp = deps.read ? undefined : memberSourceStamp(root);
  const key = stamp === undefined ? undefined : [root, stamp, version ?? "", args.join(" "), JSON.stringify(env ?? {})].join("\0");
  try {
    let doc = key === undefined ? undefined : documents.get(key);
    if (!doc) {
      doc = await (deps.read ?? ((r, a, e) => rootReader(r, e).read("graph", a)))(root, args, env);
      if (key !== undefined && memberSourceStamp(root) === stamp) {
        if (documents.size >= DOCUMENT_CACHE) documents.delete(documents.keys().next().value as string);
        documents.set(key, doc);
      }
    }
    const catalog = referenceCatalogOf(doc);
    return catalog ? { ok: true, catalog } : { ok: false, reason: "none" };
  } catch (err) {
    return { ok: false, reason: "error", message: (err instanceof Error ? err.message : String(err)).split("\n")[0] };
  }
}
