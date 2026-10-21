// #825: runtime health and rotation on the graph. Pure words and colours from
// /api/health; app.js draws them.
//
// Health is what `chant lifecycle health` says about a declared thing that
// serves: a Route 53 health check, an ECS service, a Container App, a Cloud
// Run service. It is not drift, so it never touches the card's fill: a tag
// under the card says the state, and an unhealthy card gets a solid ring in
// the degraded colour. A check chant could not read is a hole, a dashed ring
// in the neutral colour with chant's reason, never drawn as unhealthy.
//
// A Route 53 record whose health check is unhealthy is out of rotation: the
// record and its edges are dimmed and its tag says which check took it out.
// A check that is unknown or was not read leaves the record's rotation
// unknown, said in words, and nothing is dimmed.

/** The colour of each state, from the drift legend's tokens. */
export const HEALTH_COLOR = {
  healthy: "var(--managed)",
  unhealthy: "var(--degraded)",
  unknown: "var(--muted)",
  unobserved: "var(--neutral)",
  absent: "var(--muted)",
};

/** The word for each state on a card and in the legend. */
export const HEALTH_WORD = {
  healthy: "healthy",
  unhealthy: "unhealthy",
  unknown: "health unknown",
  unobserved: "health not read",
  absent: "not deployed",
};

/** The note on what health is, for the legend's tooltip. */
export const HEALTH_NOTE =
  "From chant lifecycle health: whether a declared health check or service is serving, read apart from drift. A check chant could not read is shown as not read, never as unhealthy. A Route 53 record is out of rotation when the health check its HealthCheckId names is unhealthy.";

/** Whether the answer has anything to draw. */
export function healthUsable(a) {
  return !!a && !a.error && !a.refusal && !!a.nodes;
}

/** The legend's first line: what was read, or why it wasn't. */
export function healthHeader(a) {
  if (!a || a.error) return { text: `health not read${a && a.error ? `: ${a.error}` : ""}`, title: "", tone: "refusal" };
  if (a.refusal) return { text: `health not read: ${a.refusal.error}`, title: [a.refusal.remedy, a.degraded ? `Without it, ${a.degraded}.` : ""].filter(Boolean).join("\n"), tone: "refusal" };
  const n = Object.keys(a.nodes).length;
  if (!n) return { text: "nothing declared here has a health read", title: HEALTH_NOTE, tone: "quiet" };
  return { text: `health · ${a.env}`, title: HEALTH_NOTE, tone: "quiet" };
}

/** The legend's rows: one per state that occurs, with its count, then the records out of rotation. */
export function healthLegendRows(a) {
  if (!healthUsable(a)) return [];
  const c = a.counts || {};
  const rows = [];
  for (const k of ["healthy", "unhealthy", "unknown", "unobserved", "absent"]) {
    if (c[k]) rows.push({ color: HEALTH_COLOR[k], text: HEALTH_WORD[k], count: String(c[k]) });
  }
  if (c.outOfRotation) rows.push({ color: HEALTH_COLOR.unhealthy, text: "records out of rotation", count: String(c.outOfRotation), dashed: true });
  return rows;
}

/** Members whose read was refused, as lines under the legend. */
export function memberLines(a) {
  if (!a || !Array.isArray(a.members)) return [];
  return a.members.filter((m) => m.refusal).map((m) => ({ text: `${m.member ? `${m.member}: ` : ""}health not read: ${m.refusal.error}`, title: m.refusal.remedy || "" }));
}

/** The tooltip of one node's health. */
function healthTitle(id, h) {
  if (h.state === "unobserved") return [`${id}: chant could not read its health (${h.reason}).`, h.detail || "", "This is a hole, not a verdict: the check may be fine."].filter(Boolean).join("\n");
  if (h.state === "absent") return `${id}: the provider says it is not deployed.`;
  return [`${id}: ${h.state}`, h.detail, h.checkedAt ? `checked ${h.checkedAt}` : "", `read ${h.observedAt}`].filter(Boolean).join("\n");
}

/**
 * The marks to draw, per node id in `ids` that has health or a rotation:
 * `tag` (the line under the card), `color`, `ring` (`solid`, `dashed` or
 * none), `dim` (the record is out of rotation) and `title`.
 */
export function healthMarks(a, ids) {
  const out = {};
  if (!healthUsable(a)) return out;
  const want = new Set(ids);
  for (const [id, h] of Object.entries(a.nodes)) {
    if (!want.has(id)) continue;
    const word = h.state === "unobserved" ? `${HEALTH_WORD.unobserved}: ${h.reason}` : HEALTH_WORD[h.state] || h.state;
    out[id] = {
      tag: word,
      color: HEALTH_COLOR[h.state] || "var(--muted)",
      ring: h.state === "unhealthy" ? "solid" : h.state === "unobserved" ? "dashed" : null,
      dim: false,
      title: healthTitle(id, h),
    };
  }
  for (const [id, r] of Object.entries(a.rotation || {})) {
    if (!want.has(id) || out[id]) continue;
    out[id] = {
      tag: r.line,
      color: r.inRotation === false ? HEALTH_COLOR.unhealthy : r.inRotation === true ? HEALTH_COLOR.healthy : HEALTH_COLOR.unknown,
      ring: null,
      dim: r.inRotation === false,
      title: rotationTitle(r),
    };
  }
  return out;
}

function rotationTitle(r) {
  if (r.inRotation === false) return `${r.record} is out of rotation: Route 53 stops answering with it while ${r.check} is unhealthy.`;
  if (r.inRotation === true) return `${r.record} is in rotation: ${r.check} is healthy.`;
  return `${r.record}: rotation unknown. behold has no verdict for ${r.check}, so it does not guess.`;
}

/** Whether an edge between two ids is drawn dimmed: when either end is a record out of rotation. */
export function dimEdge(a, from, to) {
  if (!healthUsable(a) || !a.rotation) return false;
  const out = (id) => !!a.rotation[id] && a.rotation[id].inRotation === false;
  return out(from) || out(to);
}

/** The inspect pane's rows for one node: label and value pairs. */
export function healthRows(a, nodeId) {
  if (!healthUsable(a)) return [];
  const rows = [];
  const h = a.nodes[nodeId];
  if (h) {
    if (h.state === "unobserved") {
      rows.push(["state", HEALTH_WORD.unobserved], ["reason", h.reason]);
      if (h.detail) rows.push(["detail", h.detail]);
    } else if (h.state === "absent") {
      rows.push(["state", HEALTH_WORD.absent]);
    } else {
      rows.push(["state", h.state], ["detail", h.detail]);
      if (h.checkedAt) rows.push(["checked", h.checkedAt]);
      rows.push(["read", h.observedAt]);
    }
    if (h.type) rows.push(["type", h.type]);
  }
  const r = a.rotation && a.rotation[nodeId];
  if (r) rows.push(["rotation", r.inRotation === false ? "out" : r.inRotation === true ? "in" : "unknown"], ["health check", r.check], ["why", r.line]);
  const routed = Object.values(a.rotation || {}).filter((x) => x.check === nodeId);
  for (const x of routed) rows.push(["guards", `${x.record} (${x.inRotation === false ? "out of rotation" : x.inRotation === true ? "in rotation" : "rotation unknown"})`]);
  return rows;
}
