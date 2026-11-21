/**
 * The shape of chant's reference catalog as behold carries it on an IR
 * (behold#1080): types and `catalogOfIr`, with no import of anything that
 * reads files or spawns chant. The painter (src/render.ts, through
 * src/catalog-draw.ts) imports this module, so it has to bundle for a
 * browser (behold#1069). The reads live in ./reference-catalog.ts, which
 * re-exports everything here.
 */
import type { GraphIR } from "@intentius/chant";

/** One rule of chant's catalog, by its id (`<lexicon>:<holder kind>:<path>`). */
export interface CatalogRule {
  id: string;
  lexicon: string;
  holderKind: string;
  path: string;
  relation: string;
  targetKinds: string[];
  /** The rule in two or three words, "runs as", "deploys to". */
  label: string;
}

/** A reference that names no node of the graph. */
export interface CatalogDangling {
  from: string;
  path: string;
  value: string;
  rule: string;
  targetKind?: string;
  /** The node the value was read through (an ExternalSecret's store). */
  through?: string;
  cluster?: string;
}

/** A reference that names several nodes, so chant drew no edge. */
export interface CatalogAmbiguous {
  from: string;
  member?: string;
  rule: string;
  path: string;
  value: string;
  candidates: string[];
}

/** A derived edge, as the document prints it. */
export interface CatalogEdge {
  from: string;
  to: string;
  kind: string;
  rule: string;
  viaAttr?: string;
  relation?: string;
  grain?: string;
  member?: string;
}

/** What one workspace read found, ids as chant composes them (`<member>/<id>`). */
export interface ReferenceCatalog {
  /** The chant that printed it. */
  chant?: string;
  rules: Record<string, CatalogRule>;
  edges: CatalogEdge[];
  dangling: CatalogDangling[];
  ambiguous: CatalogAmbiguous[];
  /** Declared edges that tie a cluster Secret to a cluster resource (`runsOn`, chant#5101). */
  runsOn: Array<{ from: string; to: string }>;
  /** Declared reads between two members, such as a Pulumi StackReference (chant#5331), ids as the composed estate has them. */
  reads?: MemberRead[];
}

/** A declared edge between two members that a read of one member cannot carry (behold#1227). */
export interface MemberRead {
  from: string;
  to: string;
  kind: string;
  /** The output read, when the reader's files name it. */
  viaAttr?: string;
}

/** The catalog on a composed estate's IR. The rules are what the picture's legend and tooltips name. */
export interface IrCatalog {
  rules: Record<string, CatalogRule>;
  /** Dangling and ambiguous references, as the document had them. */
  dangling: CatalogDangling[];
  ambiguous: CatalogAmbiguous[];
  runsOn: Array<{ from: string; to: string }>;
}

/** The IR with the catalog on it, when the estate was read through one. */
export type CatalogIr = GraphIR & { catalog?: IrCatalog; anchorNotes?: string[] };

/** The catalog of `ir`, when chant's rules decided its picture. */
export function catalogOfIr(ir: GraphIR): IrCatalog | undefined {
  return (ir as CatalogIr).catalog;
}
