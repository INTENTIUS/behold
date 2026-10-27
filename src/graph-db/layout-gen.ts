/**
 * behold#1031: the graph pane's LadybugDB layout, generated from chant's
 * graph JSON Schema (chant#4527) and behold's projection choices
 * (./layout-spec.ts).
 *
 * Pure: a schema in, a layout out. ./generate-layout.ts writes the vendored
 * schema's layout to ./layout.generated.ts at build time and checks it for
 * drift; ./layout.ts lays out the installed chant's schema at run time when
 * that chant ships one.
 *
 * Column types follow the schema: a string, a string enum or a string const
 * is STRING (with its values listed), a boolean BOOLEAN, an integer INT64, a
 * number DOUBLE, and anything structured (an object, an array, a `$ref` to an
 * object, a union of shapes) a STRING holding JSON (`json: true`).
 */
import { createHash } from "node:crypto";
import { ENUM_DEFS, LAYOUT_SPEC, type ColumnSpec, type ColumnType, type TableSpec } from "./layout-spec.ts";

export interface LayoutColumn {
  name: string;
  type: ColumnType;
  /** `behold` for behold's own column, else `<Def>.<field>`. */
  from: string;
  /** The column holds the field's value as JSON. */
  json?: boolean;
  /** The values a string column can hold, when the schema closes them. */
  values?: readonly string[];
}

export interface LayoutNodeTable {
  kind: "node";
  name: string;
  primaryKey: string;
  columns: readonly LayoutColumn[];
}

export interface LayoutRelTable {
  kind: "rel";
  name: string;
  from: { table: string; variable: string; param: string };
  to: { table: string; variable: string; param: string };
  columns: readonly LayoutColumn[];
}

export type LayoutTable = LayoutNodeTable | LayoutRelTable;

/** Where a vendored schema came from. */
export interface SchemaSource {
  repo: string;
  path: string;
  ref: string;
  commit: string;
  /** sha256 of the schema file's bytes. */
  sha256: string;
}

export interface GraphLayout {
  format: 1;
  schemaId: string;
  source: SchemaSource;
  tables: readonly LayoutTable[];
  /** `<Def>.<field>` to its string enum's values, for the defs in ENUM_DEFS. */
  enums: Readonly<Record<string, readonly string[]>>;
  ddl: readonly string[];
  inserts: Readonly<Record<string, string>>;
}

type Schema = Record<string, unknown>;

export class LayoutError extends Error {}

export const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

function defs(schema: Schema): Record<string, Schema> {
  const d = schema.$defs;
  if (!d || typeof d !== "object") throw new LayoutError("the schema has no $defs");
  return d as Record<string, Schema>;
}

/** Follow `$ref`s to the schema they name. */
function deref(schema: Schema, s: Schema, seen: string[] = []): Schema {
  const ref = s.$ref;
  if (typeof ref !== "string") return s;
  const m = /^#\/\$defs\/(.+)$/.exec(ref);
  if (!m) throw new LayoutError(`a $ref behold cannot follow: ${ref}`);
  if (seen.includes(m[1]!)) throw new LayoutError(`a $ref cycle through ${m[1]}`);
  const target = defs(schema)[m[1]!];
  if (!target) throw new LayoutError(`$ref ${ref} names no definition`);
  return deref(schema, target, [...seen, m[1]!]);
}

function refName(s: Schema): string | undefined {
  const m = typeof s.$ref === "string" ? /^#\/\$defs\/(.+)$/.exec(s.$ref) : null;
  return m?.[1];
}

function def(schema: Schema, name: string): Schema {
  const d = defs(schema)[name];
  if (!d) throw new LayoutError(`chant's schema has no definition ${name}`);
  return d;
}

function props(d: Schema, name: string): Record<string, Schema> {
  const p = d.properties;
  if (!p || typeof p !== "object") throw new LayoutError(`${name} has no properties`);
  return p as Record<string, Schema>;
}

/** The definition a `Def.prop.prop[]` path ends at, by name. */
export function followPath(schema: Schema, path: string): string | undefined {
  const [first, ...rest] = path.split(".");
  let cur: Schema = def(schema, first!);
  let name: string | undefined = first;
  for (const seg of rest) {
    const isArray = seg.endsWith("[]");
    const key = isArray ? seg.slice(0, -2) : seg;
    let p: Schema | undefined = props(deref(schema, cur), name ?? path)[key];
    if (!p) throw new LayoutError(`chant's schema has no ${key} along ${path}`);
    name = refName(p);
    p = deref(schema, p);
    if (isArray) {
      if (p.type !== "array" || !p.items || typeof p.items !== "object") throw new LayoutError(`${path}: ${key} is not an array`);
      name = refName(p.items as Schema);
      p = deref(schema, p.items as Schema);
    }
    cur = p;
  }
  return name;
}

/** The string values a property's schema closes it to, if it does. */
function stringValues(schema: Schema, s: Schema): string[] | undefined {
  const r = deref(schema, s);
  if (typeof r.const === "string") return [r.const];
  if (r.type === "string" && Array.isArray(r.enum) && r.enum.every((v) => typeof v === "string")) return [...(r.enum as string[])];
  const alts = (r.anyOf ?? r.oneOf) as Schema[] | undefined;
  if (Array.isArray(alts)) {
    const each = alts.map((a) => stringValues(schema, a));
    if (each.every((v): v is string[] => !!v)) return [...new Set(each.flat())];
  }
  return undefined;
}

function isPlainString(schema: Schema, s: Schema): boolean {
  const r = deref(schema, s);
  if (r.type === "string") return true;
  const alts = (r.anyOf ?? r.oneOf) as Schema[] | undefined;
  return Array.isArray(alts) && alts.every((a) => isPlainString(schema, a) || stringValues(schema, a) !== undefined);
}

/** A schema property to a column's type. */
export function columnOf(schema: Schema, defName: string, fieldName: string, s: Schema): LayoutColumn {
  const from = `${defName}.${fieldName}`;
  const values = stringValues(schema, s);
  if (values) return { name: fieldName, type: "STRING", from, values: [...values].sort() };
  if (isPlainString(schema, s)) return { name: fieldName, type: "STRING", from };
  const r = deref(schema, s);
  if (r.type === "boolean") return { name: fieldName, type: "BOOLEAN", from };
  if (r.type === "integer") return { name: fieldName, type: "INT64", from };
  if (r.type === "number") return { name: fieldName, type: "DOUBLE", from };
  return { name: fieldName, type: "STRING", from, json: true };
}

function enumValues(schema: Schema, ref: string): string[] {
  const [d, f] = ref.split(".");
  const v = f === undefined ? stringValues(schema, def(schema, d!)) : stringValues(schema, props(def(schema, d!), d!)[f] ?? {});
  if (!v) throw new LayoutError(`chant's schema has no string enum at ${ref}`);
  return v;
}

function tableColumns(schema: Schema, spec: TableSpec): LayoutColumn[] {
  const ownNames = new Set(spec.columns.filter((c): c is Extract<ColumnSpec, { own: string }> => "own" in c).map((c) => c.own));
  const fields = spec.def ? props(def(schema, spec.def), spec.def) : {};
  const out: LayoutColumn[] = [];
  const listed = new Set<string>();
  for (const c of spec.columns) {
    if ("own" in c) {
      const values = c.valuesFrom ? [...new Set(c.valuesFrom.flatMap((r) => enumValues(schema, r)))].sort() : undefined;
      out.push({ name: c.own, type: c.type, from: "behold", ...(values ? { values } : {}) });
      continue;
    }
    const s = fields[c.field];
    if (!s) throw new LayoutError(`chant's schema has no ${spec.def}.${c.field}, which behold's ${spec.name} table reads`);
    if (c.field in spec.omit) throw new LayoutError(`${spec.def}.${c.field} is both a ${spec.name} column and omitted`);
    out.push(columnOf(schema, spec.def!, c.field, s));
    listed.add(c.field);
  }
  for (const [name, s] of Object.entries(fields)) {
    if (listed.has(name) || name in spec.omit) continue;
    if (ownNames.has(name)) throw new LayoutError(`chant's ${spec.def}.${name} takes the name of behold's own ${spec.name}.${name} column: omit it or rename behold's column in layout-spec.ts`);
    out.push(columnOf(schema, spec.def!, name, s));
  }
  return out;
}

const ddlColumns = (cols: readonly LayoutColumn[]): string => cols.map((c) => `${c.name} ${c.type}`).join(", ");
const propMap = (cols: readonly LayoutColumn[]): string => cols.map((c) => `${c.name}: $${c.name}`).join(", ");

export function ddlOf(tables: readonly LayoutTable[]): string[] {
  return tables.map((t) =>
    t.kind === "node"
      ? `CREATE NODE TABLE ${t.name}(${ddlColumns(t.columns)}, PRIMARY KEY(${t.primaryKey}))`
      : `CREATE REL TABLE ${t.name}(FROM ${t.from.table} TO ${t.to.table}${t.columns.length ? `, ${ddlColumns(t.columns)}` : ""})`,
  );
}

export function insertsOf(tables: readonly LayoutTable[]): Record<string, string> {
  const pk = (name: string): string => {
    const t = tables.find((x) => x.name === name);
    if (!t || t.kind !== "node") throw new LayoutError(`a relation ends at ${name}, which is no node table`);
    return t.primaryKey;
  };
  const out: Record<string, string> = {};
  for (const t of tables) {
    if (t.kind === "node") out[t.name] = `CREATE (:${t.name} {${propMap(t.columns)}})`;
    else {
      const f = t.from;
      const e = t.to;
      out[t.name] =
        `MATCH (${f.variable}:${f.table} {${pk(f.table)}: $${f.param}}), (${e.variable}:${e.table} {${pk(e.table)}: $${e.param}}) ` +
        `CREATE (${f.variable})-[:${t.name}${t.columns.length ? ` {${propMap(t.columns)}}` : ""}]->(${e.variable})`;
    }
  }
  return out;
}

/** Lay out one schema. Throws LayoutError when the schema lacks what behold reads. */
export function generateLayout(schema: unknown, source: SchemaSource, spec: readonly TableSpec[] = LAYOUT_SPEC): GraphLayout {
  if (!schema || typeof schema !== "object") throw new LayoutError("the schema is not an object");
  const s = schema as Schema;
  if (typeof s.$id !== "string") throw new LayoutError("the schema has no $id");
  const tables: LayoutTable[] = [];
  for (const t of spec) {
    for (const path of t.reachedBy) {
      const reached = followPath(s, path);
      if (reached !== t.def) throw new LayoutError(`${path} is ${reached ?? "an inline shape"} in chant's schema, not ${t.def}, which behold's ${t.name} table lays out`);
    }
    const columns = tableColumns(s, t);
    tables.push(t.kind === "node" ? { kind: "node", name: t.name, primaryKey: t.primaryKey, columns } : { kind: "rel", name: t.name, from: t.from, to: t.to, columns });
    if (t.kind === "node" && !columns.some((c) => c.name === t.primaryKey)) throw new LayoutError(`${t.name}'s primary key ${t.primaryKey} is not one of its columns`);
  }
  const enums: Record<string, string[]> = {};
  for (const d of ENUM_DEFS) {
    const dd = def(s, d);
    const whole = stringValues(s, dd);
    if (whole) {
      enums[d] = [...whole].sort();
      continue;
    }
    for (const [f, p] of Object.entries(props(dd, d))) {
      const v = stringValues(s, p);
      if (v) enums[`${d}.${f}`] = [...v].sort();
    }
  }
  return { format: 1, schemaId: s.$id, source, tables, enums, ddl: ddlOf(tables), inserts: insertsOf(tables) };
}

/** The checked-in TypeScript for a layout: ./layout.generated.ts. */
export function renderLayout(layout: GraphLayout): string {
  return [
    "// Generated by src/graph-db/generate-layout.ts from src/graph-db/chant-schema/graph.schema.json",
    `// (chant ${layout.source.commit}, ${layout.source.path}). Do not edit:`,
    "// run `npm run generate:graph-layout`; `npm run check:graph-layout` fails when this file drifts (behold#1031).",
    'import type { GraphLayout } from "./layout-gen.ts";',
    "",
    `export const GRAPH_LAYOUT = ${JSON.stringify(layout, null, 2)} as const satisfies GraphLayout;`,
    "",
  ].join("\n");
}

/** The columns and statements two layouts differ in, as lines; empty when they lay out the same database. */
export function layoutDiff(a: GraphLayout, b: GraphLayout): string[] {
  const out: string[] = [];
  const names = [...new Set([...a.tables.map((t) => t.name), ...b.tables.map((t) => t.name)])];
  for (const n of names) {
    const ta = a.tables.find((t) => t.name === n);
    const tb = b.tables.find((t) => t.name === n);
    if (!ta || !tb) {
      out.push(`${n}: ${ta ? "dropped" : "added"}`);
      continue;
    }
    const ca = new Map(ta.columns.map((c) => [c.name, c]));
    const cb = new Map(tb.columns.map((c) => [c.name, c]));
    for (const [k, c] of cb) if (!ca.has(k)) out.push(`${n}.${k}: added (${c.type}${c.json ? ", JSON" : ""}, from ${c.from})`);
    for (const k of ca.keys()) if (!cb.has(k)) out.push(`${n}.${k}: dropped`);
    for (const [k, c] of cb) {
      const o = ca.get(k);
      if (o && JSON.stringify(o) !== JSON.stringify(c)) out.push(`${n}.${k}: ${JSON.stringify(o)} is now ${JSON.stringify(c)}`);
    }
  }
  for (const k of new Set([...Object.keys(a.enums), ...Object.keys(b.enums)])) {
    if (JSON.stringify(a.enums[k]) !== JSON.stringify(b.enums[k])) out.push(`enum ${k}: ${JSON.stringify(a.enums[k] ?? null)} is now ${JSON.stringify(b.enums[k] ?? null)}`);
  }
  if (!out.length && JSON.stringify(a.ddl) !== JSON.stringify(b.ddl)) out.push("the column order differs");
  return out;
}
