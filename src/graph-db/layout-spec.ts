/**
 * behold#1031: what behold projects from chant's graph schema into the
 * graph pane's LadybugDB, and nothing about how a column is typed.
 *
 * The types, the enums and the set of fields come from chant's JSON Schema
 * (chant#4527, packages/core/src/graph-schema/graph.schema.json), read by
 * ./layout-gen.ts. This file holds the decisions only behold can make:
 *
 *  - the column order, so the DDL stays stable from one schema to the next;
 *  - behold's own columns (the session's keys and the display columns the
 *    resolve rules and templates read), marked `own`;
 *  - each schema field behold leaves out, with the reason.
 *
 * A field chant adds that is neither a column here nor in `omit` is appended
 * as a column by the generator, so a schema change shows up as a layout
 * change (and the drift check fails until the checked-in layout is
 * regenerated) instead of being dropped silently. A field named here that the
 * schema no longer has fails generation. A new schema field that takes the
 * name of one of behold's own columns fails too, until it is omitted or
 * renamed here.
 */

export type ColumnType = "STRING" | "BOOLEAN" | "DOUBLE" | "INT64";

/** A column taken from one property of the table's schema definition. */
export interface FieldColumnSpec {
  field: string;
}

/** A column behold computes; `valuesFrom` names schema enums whose values it can hold. */
export interface OwnColumnSpec {
  own: string;
  type: ColumnType;
  valuesFrom?: readonly string[];
}

export type ColumnSpec = FieldColumnSpec | OwnColumnSpec;

export interface NodeTableSpec {
  kind: "node";
  name: string;
  /** The `$defs` entry the field columns come from. */
  def: string;
  /** Where the documents reach the definition, `Def.prop[]` paths; each must resolve to `def`. */
  reachedBy: readonly string[];
  primaryKey: string;
  columns: readonly ColumnSpec[];
  omit: Readonly<Record<string, string>>;
}

export interface RelEndSpec {
  table: string;
  /** The variable the insert statement binds the end to. */
  variable: string;
  /** The row field holding the end's primary key. */
  param: string;
}

export interface RelTableSpec {
  kind: "rel";
  name: string;
  def?: string;
  reachedBy: readonly string[];
  from: RelEndSpec;
  to: RelEndSpec;
  columns: readonly ColumnSpec[];
  omit: Readonly<Record<string, string>>;
}

export type TableSpec = NodeTableSpec | RelTableSpec;

const own = (name: string, type: ColumnType = "STRING", valuesFrom?: readonly string[]): OwnColumnSpec => ({ own: name, type, ...(valuesFrom ? { valuesFrom } : {}) });
const field = (name: string): FieldColumnSpec => ({ field: name });

/** behold#1025's three tables and KNOWN_AS, in DDL order. */
export const LAYOUT_SPEC: readonly TableSpec[] = [
  {
    kind: "node",
    name: "Resource",
    def: "IRNode",
    reachedBy: ["EngineGraphDocument.nodes[]", "IndexDocument.graph.nodes[]", "GraphIR.nodes[]"],
    primaryKey: "key",
    columns: [
      own("key"),
      own("source"),
      own("scopeKey"),
      own("version"),
      field("id"),
      field("kind"),
      field("lexicon"),
      field("listedType"),
      field("location"),
      field("nativeId"),
      own("name"),
      own("address"),
      // behold#906 Q4: chant's verdict (owned, foreign) and the engine's (bound, unowned, pending, foreign) are two columns.
      field("ownership"),
      own("engineOwnership", "STRING", ["EngineFacts.ownership"]),
      field("attrs"),
      field("tags"),
      field("facts"),
      own("observedAt"),
    ],
    omit: {
      compositeParent: "a composite's parent is chant's grouping; the pane reads it from chant search",
      compositeInstance: "as compositeParent",
      sourceLoc: "where a node was declared is chant's view, not the session's",
      physicalId: "loaded as a CloudId with a KNOWN_AS edge, not a column",
      runtimeOwner: "not read by the pane's resolve rules or templates",
      instanceOf: "instances load as their own nodes; the block they expand is chant search's",
      instanceKey: "as instanceOf",
      instanceScope: "as instanceOf",
      instanceRollup: "as instanceOf",
      unmappedKind: "kind and listedType say the same for the pane",
    },
  },
  {
    kind: "node",
    name: "CloudId",
    def: "EngineCloudId",
    reachedBy: ["IRNode.facts.cloudIds[]"],
    primaryKey: "value",
    columns: [field("value"), field("kind")],
    omit: {},
  },
  {
    kind: "rel",
    name: "KNOWN_AS",
    reachedBy: [],
    from: { table: "Resource", variable: "r", param: "key" },
    to: { table: "CloudId", variable: "c", param: "value" },
    columns: [],
    omit: {},
  },
  {
    kind: "rel",
    name: "REF",
    def: "IREdge",
    reachedBy: ["EngineGraphDocument.edges[]", "IndexDocument.graph.edges[]", "GraphIR.edges[]"],
    from: { table: "Resource", variable: "a", param: "from" },
    to: { table: "Resource", variable: "b", param: "to" },
    columns: [field("kind"), field("viaAttr"), field("toAttr"), field("grain"), field("origin"), field("rule"), field("relation"), own("ambiguous", "BOOLEAN")],
    omit: {
      from: "the edge's start, the relation's FROM",
      to: "the edge's end, the relation's TO",
      crossPipeline: "CI pipelines are not loaded into the pane",
    },
  },
];

/** The schema definitions whose string enums the generated layout lists, so behold's type copies are checked against them. */
export const ENUM_DEFS: readonly string[] = ["IRNode", "IREdge", "EngineFacts", "EngineMarkers", "EngineCloudId", "EdgeGrain", "IREdgeKind"];
