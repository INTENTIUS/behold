/**
 * What a card prints at the attributes zoom. The resources zoom prints a
 * card's two shortest plain values. At attributes, a card also says what its
 * structured attributes hold: a rule list as its count, a short list of
 * values as the values, a reference as the name it points at. pinhole draws
 * four lines at most (`MAX_FIELDS`), so the plain values come first and the
 * structured ones fill the rest.
 */
import { defaultFields } from "@intentius/pinhole";

/** The attr the attributes zoom stamps on a card, read by the lexicon packs' fields. */
export const ATTRS_ZOOM = "_attrsZoom";

const MAX_LINES = 4;
const SHORT = 22;

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** A reference's target: `{ $ref: "aws/web.GroupId" }`, `{ Ref: "web" }`, `{ "Fn::GetAtt": ["web", "Arn"] }`. */
function refTarget(v: Record<string, unknown>): string | undefined {
  const r = v.$ref ?? v.Ref ?? (Array.isArray(v["Fn::GetAtt"]) ? (v["Fn::GetAtt"] as unknown[])[0] : undefined);
  if (typeof r !== "string") return undefined;
  return r.replace(/^[^/]*\//, "").replace(/\..*$/, "");
}

/** One structured value, summarized to a line, or undefined when it says nothing short. */
export function summarize(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    if (!v.length) return undefined;
    if (v.every(isScalar)) {
      const joined = v.map(String).join(", ");
      return joined.length <= SHORT ? joined : `${v.length} values`;
    }
    const refs = v.map((x) => (x && typeof x === "object" ? refTarget(x as Record<string, unknown>) : undefined));
    if (refs.every(Boolean)) {
      const joined = `→ ${refs.join(", ")}`;
      return joined.length <= SHORT ? joined : `→ ${v.length} cards`;
    }
    return `${v.length} ${v.length === 1 ? "entry" : "entries"}`;
  }
  if (v && typeof v === "object") {
    const ref = refTarget(v as Record<string, unknown>);
    if (ref) return `→ ${ref}`;
    const n = Object.keys(v).length;
    return n ? `${n} ${n === 1 ? "setting" : "settings"}` : undefined;
  }
  return undefined;
}

/** The lines a card prints at the attributes zoom. */
export function attributeFields(node: { attrs: Record<string, unknown> }): Array<{ label: string; value: string }> {
  const plain = defaultFields(node as never);
  const out = [...plain];
  for (const key of Object.keys(node.attrs).sort()) {
    if (out.length >= MAX_LINES) break;
    if (key.startsWith("_") || isScalar(node.attrs[key])) continue;
    const value = summarize(node.attrs[key]);
    if (value) out.push({ label: key, value });
  }
  return out;
}
