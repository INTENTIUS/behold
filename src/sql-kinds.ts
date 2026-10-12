/**
 * #524: the `sql` lexicon's kinds (`@intentius/chant-lexicon-sql`, which SQL
 * Yodeler projects declare their schema with), as cards: a glyph per kind and
 * the two fields a card leads with.
 *
 * pinhole's keyword heuristic reads `Postgres::Index` and `Postgres::Schema`
 * as a database and `ClickHouse::Table` as nothing, so the pack names a
 * bundled line glyph per kind instead. The kinds are the lexicon's entity
 * types at 0.124.x. A kind not listed falls through to the heuristic.
 *
 * A node's attrs are the entity's parsed definition (`props`): `name`, and
 * `schema` (Postgres) or `database` (ClickHouse), `columns`, `foreignKeys`.
 */

/** The lexicon chant-lexicon-sql's entities belong to. */
export const SQL_LEXICON = "sql";

/** Each kind's glyph, a pinhole GENERIC_GLYPHS key. */
const GLYPH_BY_KIND: Record<string, string> = {
  "Postgres::Schema": "database",
  "Postgres::Table": "table",
  "Postgres::View": "table",
  "Postgres::MaterializedView": "table",
  "Postgres::Index": "route",
  "Postgres::Sequence": "queue",
  "Postgres::Enum": "generic",
  "Postgres::Domain": "generic",
  "Postgres::Extension": "container",
  "Postgres::Function": "function",
  "Postgres::Procedure": "function",
  "Postgres::Trigger": "function",
  "Postgres::Role": "user",
  "Postgres::Grant": "secret",
  "Postgres::DefaultPrivileges": "secret",
  "Postgres::Policy": "firewall",
  "ClickHouse::Catalog": "database",
  "ClickHouse::Database": "database",
  "ClickHouse::Table": "table",
  "ClickHouse::View": "table",
  "ClickHouse::MaterializedView": "pipeline",
  "ClickHouse::Dictionary": "storage",
  "ClickHouse::Function": "function",
  "ClickHouse::Role": "user",
  "ClickHouse::User": "user",
  "ClickHouse::Grant": "secret",
  "ClickHouse::RowPolicy": "firewall",
};

/** The glyph for a `sql` lexicon kind, or undefined to fall through. */
export function sqlIconFor(kind: string): string | undefined {
  return GLYPH_BY_KIND[kind];
}

/** Every kind this module names, for tests and docs. */
export function sqlKinds(): string[] {
  return Object.keys(GLYPH_BY_KIND);
}

/** "Postgres table", "ClickHouse materialized view": the kind in words. */
export function sqlKindLabel(kind: string): string {
  const m = /^(Postgres|ClickHouse)::(\w+)$/.exec(kind);
  if (!m) return kind;
  const words = m[2]!.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return `${m[1]} ${words}`;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * A sql card's fields: the kind in words with its qualified name, then what
 * the definition holds most of (columns and foreign keys on a table, the
 * table an index is on). Undefined for a node that is not a sql entity.
 */
export function sqlCardFields(node: { kind: string; attrs: Record<string, unknown> }): Array<{ label: string; value: string }> | undefined {
  if (!/^(Postgres|ClickHouse)::/.test(node.kind)) return undefined;
  const a = node.attrs ?? {};
  const name = str(a.name);
  const scope = str(a.schema) ?? str(a.database);
  const fields = [{ label: sqlKindLabel(node.kind), value: name ? (scope ? `${scope}.${name}` : name) : "" }];
  const columns = Array.isArray(a.columns) ? a.columns.length : 0;
  const fks = Array.isArray(a.foreignKeys) ? a.foreignKeys.length : 0;
  if (columns) fields.push({ label: "columns", value: `${columns}${fks ? `, ${fks} foreign key${fks === 1 ? "" : "s"}` : ""}` });
  else if (str(a.table)) fields.push({ label: "on", value: str(a.table)! });
  else if (str(a.engine)) fields.push({ label: "engine", value: str(a.engine)! });
  return fields;
}
