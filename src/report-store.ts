/**
 * Every CI product's report store, in chant's format (behold#1228).
 *
 * chant's `@intentius/chant/report-store` names what a CI product puts in its
 * reports bucket: `chant.estate/v1`, `chant.dora/v1`, `chant.run/v1` and the
 * `chant.audit/v1` line, each naming its product in `product`, and it keeps
 * the ids the products wrote before (`terragucci.estate/v1`,
 * `terragucci.report/v1`, ...) readable as the same kinds. behold reads both:
 *
 * - A document under a neutral id is checked against chant's published JSON
 *   Schema of its kind (`@intentius/chant/report-store/<kind>.schema.json`).
 *   When its product is one behold also reads in the product's own words
 *   (terragucci), {@link productView} gives it back under the product-named id,
 *   so the reader built on that product's schema reads it unchanged.
 * - An audit line is read by chant's `readAuditLine`, which maps a
 *   terragucci line, a sql-yodeler line and a `chant.audit/v1` line onto the
 *   same line; {@link checkAuditLine} checks the mapped line against chant's
 *   audit schema.
 *
 * behold computes none of this: the kinds, the ids and the mapping are chant's.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import { readAuditLine, readReportSchema, type AuditLine, type ReadAuditOptions, type ReportKind } from "@intentius/chant/report-store";
import auditSchema from "@intentius/chant/report-store/audit.schema.json" with { type: "json" };
import doraSchema from "@intentius/chant/report-store/dora.schema.json" with { type: "json" };
import estateSchema from "@intentius/chant/report-store/estate.schema.json" with { type: "json" };
import runSchema from "@intentius/chant/report-store/run.schema.json" with { type: "json" };

export type { AuditLine, ReportKind };
export { readReportSchema };

/** The package path of each published schema, for messages. */
export const STORE_SCHEMA_FILES: Readonly<Record<ReportKind, string>> = {
  estate: "@intentius/chant/report-store/estate.schema.json",
  dora: "@intentius/chant/report-store/dora.schema.json",
  run: "@intentius/chant/report-store/run.schema.json",
  audit: "@intentius/chant/report-store/audit.schema.json",
};

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

let compiled: Record<ReportKind, ReturnType<Ajv2020["compile"]>> | undefined;
function validators(): Record<ReportKind, ReturnType<Ajv2020["compile"]>> {
  if (compiled) return compiled;
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  compiled = {
    estate: ajv.compile(estateSchema as object),
    dora: ajv.compile(doraSchema as object),
    run: ajv.compile(runSchema as object),
    audit: ajv.compile(auditSchema as object),
  };
  return compiled;
}

/** Why `doc` is not a `kind` document by chant's published schema, or undefined when it is one. */
export function checkStoreDoc(kind: ReportKind, doc: unknown): string | undefined {
  if (!isRecord(doc)) return "it is not a JSON object";
  const id = readReportSchema(doc.schema);
  if (id?.kind !== kind) return `its schema is ${JSON.stringify(doc.schema)}, not chant.${kind}/v1 or a product's ${kind} id`;
  const v = validators()[kind];
  if (v(doc)) return undefined;
  const e = v.errors?.[0];
  return `chant's ${kind}.schema.json rejects it: ${e?.instancePath || "/"} ${e?.message ?? "is invalid"}`;
}

/** The product a document names: its `product`, else the product of its id. Undefined for a document of neither. */
export function storeProduct(doc: unknown): string | undefined {
  if (!isRecord(doc)) return undefined;
  if (typeof doc.product === "string" && doc.product !== "") return doc.product;
  return readReportSchema(doc.schema)?.product;
}

/**
 * `doc` as the product-named document `productId` names, for a reader built
 * on that product's own schema. A document under that id is returned as it
 * is. A document under the neutral id of the same kind, whose `product` is
 * the product the id names, is checked against chant's schema and returned
 * with `schema` set to `productId` and `product` left out. Anything else is
 * returned as it is, so the product's own check refuses it by name.
 */
export function productView(doc: unknown, productId: string): { doc: unknown; neutral: boolean; problem?: string } {
  if (!isRecord(doc)) return { doc, neutral: false };
  const want = readReportSchema(productId);
  const have = readReportSchema(doc.schema);
  if (!want || !have?.neutral || have.kind !== want.kind) return { doc, neutral: false };
  if (doc.product !== want.product) return { doc, neutral: true, problem: `it is chant.${have.kind}/v1 from ${JSON.stringify(doc.product)}, not from ${want.product}` };
  const why = checkStoreDoc(have.kind, doc);
  if (why) return { doc, neutral: true, problem: why };
  const { product: _product, schema: _schema, ...rest } = doc;
  return { doc: { schema: productId, ...rest }, neutral: true };
}

/**
 * One `audit.jsonl` line as `chant.audit/v1`, by chant's `readAuditLine`, and
 * checked against chant's audit schema. `line` is undefined, with `problem`
 * saying why, for a line that is none of the formats chant reads.
 */
export function checkAuditLine(raw: unknown, options: ReadAuditOptions = {}): { line?: AuditLine; problem?: string } {
  if (!isRecord(raw)) return { problem: "it is not a JSON object" };
  const line = readAuditLine(raw, options);
  if (!line) {
    const id = readReportSchema(raw.schema);
    return {
      problem:
        id?.kind === "audit"
          ? `it is ${String(raw.schema)} but lacks an id, a kind chant names, a product or its evidence`
          : raw.schema === undefined
            ? "it has no schema and is not a sql-yodeler audit line (id, kind, environment and source)"
            : `its schema is ${JSON.stringify(raw.schema)}, not an audit id`,
    };
  }
  const why = checkStoreDoc("audit", line);
  return why ? { problem: why } : { line };
}
