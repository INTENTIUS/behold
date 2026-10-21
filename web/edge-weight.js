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
// Only references are weighed: a CI edge (needs, calls, triggers, …) keeps its
// own kind's style (./edge-kind.js).

/** The weights, strongest first, each with what it means in the key. */
export const WEIGHTS = {
  wired: "wired: the traffic path",
  reference: "reference: names another",
  inferred: "inferred: matched by name",
  plumbing: "plumbing: identity, keys, logs",
};

/** Kinds whose incoming references are plumbing, not traffic. */
const PLUMBING_KIND = /(::IAM::|::Iam::|::KMS::|::Kms::|::Logs::|::SecretsManager::|::SecretManager::|::SSM::|ManagedIdentity\/|OperationalInsights\/|KeyVault\/|Microsoft\.Authorization\/|::Logging::|::Monitoring::|::CloudWatch::Alarm)/;

/** Attributes whose references are the traffic path, as declared. */
const WIRED_VIA = /^(import|TargetGroupArn|DefaultActions|LoadBalancers|ResourceRecords|AliasTarget|EventSourceArn|FunctionName|Endpoint|TopicArn|QueueUrl|target|defaultService|backend|urlMapRef|serviceRef|networkEndpointGroupRef|ingress|managedEnvironmentId|from outside)$/;

/**
 * The weight of each reference edge, keyed `from→to`. `kindOf` maps a node id
 * to its kind. A CI edge gets no entry.
 */
export function edgeWeights(edges = [], kindOf = new Map()) {
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
    if (plumbing(e)) {
      const hub = PLUMBING_KIND.test(kindOf.get(e.to) || "") ? e.to : e.from;
      w = (sharers.get(hub)?.size ?? 0) > 2 ? "hidden" : "plumbing";
    } else if (e.inferred) w = "inferred";
    else if (WIRED_VIA.test(String(e.viaAttr || "").split(".").pop())) w = "wired";
    else w = "reference";
    out.set(`${e.from}→${e.to}`, w);
  }
  return out;
}

/** The key's rows: one per weight the graph draws, with its count. Hidden edges aren't drawn, so aren't counted. */
export function weightLegend(weights) {
  const counts = new Map();
  for (const w of weights.values()) if (w !== "hidden") counts.set(w, (counts.get(w) || 0) + 1);
  if (counts.size < 2) return [];
  return Object.keys(WEIGHTS)
    .filter((w) => counts.has(w))
    .map((w) => ({ weight: w, label: w, title: WEIGHTS[w], count: counts.get(w) }));
}
