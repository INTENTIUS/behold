/**
 * Secret-bearing values are masked before a row reaches LadybugDB
 * (src/graph-db/rows.ts). The cloud lister that once sat beside this in
 * behold (behold#1029) moved to chant (chant#4532), which masks with the same
 * list before a `ListingResult` exists. rows.ts masks again, so no row holds
 * a secret whatever produced the document (#1025 "Source interface").
 *
 * The key list, the masked value and the masking are chant's own: the
 * lister's `@intentius/chant/cloud-lister/mask`, over `SENSITIVE_KEY_PATTERNS`
 * (packages/core/src/sensitive-key.ts), the one list chant's observation
 * paths and its lister share. behold#1005 flipped src/chant-release.ts, so
 * behold keeps no copy.
 */
export { isSensitiveKey, MASKED, maskValue, SENSITIVE_KEY_PATTERNS } from "@intentius/chant/cloud-lister/mask";
