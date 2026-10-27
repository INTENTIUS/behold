/**
 * Secret-bearing values are masked before a row reaches LadybugDB
 * (src/graph-db/rows.ts). The cloud lister that once sat beside this in
 * behold (behold#1029) moved to chant (chant#4532), which masks with the same
 * list before a `ListingResult` exists. rows.ts masks again, so no row holds
 * a secret whatever produced the document (#1025 "Source interface").
 *
 * The key list is chant's `SENSITIVE_KEY_PATTERNS`
 * (packages/core/src/sensitive-key.ts on chant's integration branch), the
 * one list chant's observation paths and its lister share. Published chant
 * (0.124.52) does not export that module yet, so the same patterns are copied
 * here; src/graph-db/mask.test.ts compares the two when the installed chant
 * has it.
 *
 * TODO(chant#4532, behold#1005): once src/chant-release.ts says
 * `released: true`, import the list from `@intentius/chant/sensitive-key`.
 */

export const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /password/i,
  /secret/i,
  /token/i,
  /private.?key/i,
  /credential/i,
  /connection.?string/i,
];

/** What a masked value becomes, as chant's lister writes it. A fixed string, so a masked value never diffs. */
export const MASKED = "<masked>";

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

/**
 * A deep copy of `value` with every value under a sensitive key replaced by
 * {@link MASKED}. Arrays of `{Key, Value}` / `{key, value}` pairs (AWS tags,
 * some ARM shapes) are masked by the pair's key as well.
 */
export function maskValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => maskValue(v));
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const pairKey = typeof obj.Key === "string" ? obj.Key : typeof obj.key === "string" ? obj.key : undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSensitiveKey(k)) {
      out[k] = MASKED;
    } else if (pairKey !== undefined && isSensitiveKey(pairKey) && (k === "Value" || k === "value")) {
      out[k] = MASKED;
    } else {
      out[k] = maskValue(v);
    }
  }
  return out;
}
