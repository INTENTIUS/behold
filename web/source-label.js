/**
 * behold#1191: a graph database source in plain words. A source's scope key
 * (`chant/aws`, `engine/choudoufu/three-cloud-azure@azure`,
 * `cloud/aws/000000000000/db1d7f66ad8c`) is what behold keys it by; a person
 * reads "the aws member" or "the AWS account's index". The ask demo's replies
 * (filled by scripts/ask-demo/narration.ts), its source lines and its load
 * panel all name a source with this one function, and keep the raw key where
 * it is needed: in the rows table and on hover.
 *
 * A key of a shape this does not know is returned as it is, never guessed at.
 */

const CLOUDS = { aws: "AWS account", azure: "Azure subscription", gcp: "GCP project" };

/** A scope key in plain words, or the key itself when its shape is not one behold makes. */
export function sourceLabel(scopeKey) {
  if (typeof scopeKey !== "string" || !scopeKey) return "";
  const parts = scopeKey.split("/");
  const [kind, a, b] = parts;
  if (kind === "chant" && parts.length === 2 && a) return a === "." ? "the project" : `the ${a} member`;
  if (kind === "engine" && a && parts.length >= 3) {
    const rest = parts.slice(2).join("/");
    const at = rest.lastIndexOf("@");
    if (at > 0 && at < rest.length - 1) return `the ${rest.slice(at + 1)} member's ${a} graph`;
    return `${a}'s graph of ${rest}`;
  }
  if (kind === "cloud" && a && b && parts.length === 4) {
    if (a === "kubernetes") return b.startsWith("kind-") ? "the kind cluster's index" : "the cluster's index";
    return CLOUDS[a] ? `the ${CLOUDS[a]}'s index` : `the ${a} index`;
  }
  return scopeKey;
}
