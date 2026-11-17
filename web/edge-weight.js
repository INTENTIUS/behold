// behold#878: how much an edge says, from how it was found.
//
// Every reference used to draw the same line. They are not the same: a
// listener forwarding to its targets, or a DNS record naming the endpoint it
// sends people to, is traffic the estate was built to carry; a plain
// reference is a dependency; an edge found by matching names is a guess the
// graph made; and a reference to an identity, a key, a log group or a secret
// is plumbing every workload has, which says little about how the estate is
// put together. Plumbing that more than two cards share (one role for half
// the estate) says nothing at all, so it draws no edge.
//
// An edge chant derived (`origin: "derived"` with the `rule` that drew it,
// chant#4522/#4523, behold#1030) is a match chant made, not a declaration, so
// it weighs as an inferred one does.
//
// behold#1080: a catalog rule chant drew an edge by (chant#5097) is an exact
// match, not a guess, so it is "joined" and apart from "inferred", with the
// rule in its tooltip. A reference that names no node is drawn to a dashed
// placeholder card ("dangling"), and one that names several gets a dotted edge
// to each candidate ("ambiguous"). src/catalog-draw.ts adds the card and the
// edges and marks them (`dangling: true`, `ambiguous: { of, rule, value }`).
// behold#1132: the key says what such an edge is to someone reading the
// picture (a field of one object names or selects the other), not how chant
// found it.
//
// Only references are weighed: a CI edge (needs, calls, triggers, …) keeps its
// own kind's style (./edge-kind.js).

/** The weights, strongest first, each with what it means in the key. */
export const WEIGHTS = {
  wired: "wired: the traffic path",
  reference: "reference: names another",
  joined: "joined: a field names or selects the other object",
  inferred: "inferred: matched by name",
  plumbing: "plumbing: identity, keys, logs",
  dangling: "dangling: names nothing declared (dashed card)",
  ambiguous: "ambiguous: one of several candidates (dotted)",
};

/** The weights chant's catalog adds. A key with one of these is worth a row when it is the only weight drawn. */
export const CATALOG_WEIGHTS = ["joined", "dangling", "ambiguous"];

/** The rules that drew an edge that is neither a behold pass nor chant's identity-match pass. */
const NOT_CATALOG_RULE = /^(behold:|identity-match:)/;

/**
 * Whether an edge was drawn by a catalog rule. `rules` is the catalog's rule
 * table (ids as keys) when the graph has one; without it, an edge chant stamped
 * with a `relation` (chant#5097 gives every catalog edge one) counts.
 */
export function isCatalogEdge(e, rules) {
  if (e.origin !== "derived" || typeof e.rule !== "string" || !e.rule || NOT_CATALOG_RULE.test(e.rule)) return false;
  if (rules && Object.keys(rules).length) return Object.prototype.hasOwnProperty.call(rules, e.rule);
  return typeof e.relation === "string";
}

/** Kinds whose incoming references are plumbing, not traffic. */
const PLUMBING_KIND = /(::IAM::|::Iam::|::KMS::|::Kms::|::Logs::|::SecretsManager::|::SecretManager::|::SSM::|ManagedIdentity\/|OperationalInsights\/|KeyVault\/|Microsoft\.Authorization\/|::Logging::|::Monitoring::|::CloudWatch::Alarm)/;

/** Attributes whose references are the traffic path, as declared. */
const WIRED_VIA = /^(import|TargetGroupArn|DefaultActions|LoadBalancers|ResourceRecords|AliasTarget|EventSourceArn|FunctionName|Endpoint|TopicArn|QueueUrl|target|defaultService|backend|urlMapRef|serviceRef|networkEndpointGroupRef|ingress|managedEnvironmentId|from outside)$/;

/** Whether a reference edge is the traffic path, as declared. */
export function isWired(e) {
  return WIRED_VIA.test(String(e.viaAttr || "").split(".").pop());
}

/**
 * The weight of each reference edge, keyed `from→to`. `kindOf` maps a node id
 * to its kind. A CI edge gets no entry.
 */
export function edgeWeights(edges = [], kindOf = new Map(), rules = undefined) {
  const out = new Map();
  const plumbing = (e) => PLUMBING_KIND.test(kindOf.get(e.to) || "") || PLUMBING_KIND.test(kindOf.get(e.from) || "");
  const sharers = new Map();
  for (const e of edges) {
    if (e.kind && e.kind !== "ref") continue;
    if (!plumbing(e)) continue;
    const hub = PLUMBING_KIND.test(kindOf.get(e.to) || "") ? e.to : e.from;
    const other = hub === e.to ? e.from : e.to;
    (sharers.get(hub) ?? sharers.set(hub, new Set()).get(hub)).add(other);
  }
  for (const e of edges) {
    if (e.kind && e.kind !== "ref") continue;
    let w;
    if (e.ambiguous) w = "ambiguous";
    else if (e.dangling === true) w = "dangling";
    else if (plumbing(e)) {
      const hub = PLUMBING_KIND.test(kindOf.get(e.to) || "") ? e.to : e.from;
      w = (sharers.get(hub)?.size ?? 0) > 2 ? "hidden" : "plumbing";
    } else if (isCatalogEdge(e, rules)) w = "joined";
    else if (e.inferred || e.origin === "derived") w = "inferred";
    else if (isWired(e)) w = "wired";
    else w = "reference";
    out.set(`${e.from}→${e.to}`, w);
  }
  return out;
}

/** The key's rows: one per weight the graph draws, with its count. Hidden edges aren't drawn, so aren't counted. */
export function weightLegend(weights) {
  const counts = new Map();
  for (const w of weights.values()) if (w !== "hidden") counts.set(w, (counts.get(w) || 0) + 1);
  if (counts.size < 2 && !CATALOG_WEIGHTS.some((w) => counts.has(w))) return [];
  return Object.keys(WEIGHTS)
    .filter((w) => counts.has(w))
    .map((w) => ({ weight: w, label: w, title: WEIGHTS[w], count: counts.get(w) }));
}
