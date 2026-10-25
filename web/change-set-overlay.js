// #681: a waiting gate's change set, drawn on the graph as a preview. Pure
// words and colours from /api/workspace/change-set; app.js draws them.
//
// The colours are the graph's own (the drift legend's tokens): a card the
// change set creates is outlined in the managed green, one it updates or
// replaces in the foreign yellow, one it deletes or forgets in the degraded
// red. A card with entries of several kinds takes the one that destroys most.
// The outline and a tag above the card are the marks; the fill stays the
// live-status channel, so a preview never reads as what is live.

/** The legend's buckets, in order, with the token each is drawn in. */
export const BUCKETS = [
  { bucket: "create", color: "var(--managed)", label: "create", title: "The change set creates these." },
  { bucket: "change", color: "var(--foreign)", label: "update or replace", title: "The change set updates these in place, or replaces them (a new object for the old one)." },
  { bucket: "delete", color: "var(--degraded)", label: "delete or forget", title: "The change set deletes these, or forgets them (chant stops managing the object and leaves it standing)." },
];
const COLOR = Object.fromEntries(BUCKETS.map((b) => [b.bucket, b.color]));

/** The colour a bucket is drawn in. */
export const bucketColor = (bucket) => COLOR[bucket] || "var(--muted)";

const short = (s) => (s ? String(s).replace(/^(jcs1-)?sha256:/, "").slice(0, 12) : "");
const sha7 = (s) => (s ? String(s).slice(0, 7) : "");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The note under the overlay's legend: it is a preview. */
export const PREVIEW_NOTE = "A preview of what approving this gate lets chant apply. Nothing on the graph has changed yet.";

/** The overlay's first lines: the change set, the gate and commit it belongs to, or why it wasn't read. */
export function overlayHeader(a) {
  if (!a || a.error) return { lines: [`change set not read${a && a.error ? `: ${a.error}` : ""}`], tone: "refusal", title: "" };
  if (a.refusal) return { lines: [`change set not read: ${a.refusal.error}`], tone: "refusal", title: a.refusal.remedy || "" };
  const g = a.gate;
  const lines = [`change set ${short(a.digest)} · gate ${g.key}${g.env ? ` in ${g.env}` : ""}`];
  const facts = [];
  const commit = g.gitSha || (a.graph && a.graph.at);
  facts.push(commit ? `commit ${sha7(commit)}` : "commit unknown");
  if (g.runId) facts.push(`run ${g.runId}`);
  if (a.planned) facts.push(`release ${short(a.planned.releaseDigest)} planned for ${a.planned.environment}`);
  lines.push(facts.join(" · "));
  const title = [
    `change set ${a.digest}`,
    commit ? `commit ${commit}${g.gitSha ? "" : " (the commit chant read the graph at)"}` : "",
    a.planned ? `release ${a.planned.releaseDigest}` : "",
    a.graph ? `nodes from the graph of ${a.graph.member || "the project"}${a.graph.at ? ` at ${sha7(a.graph.at)}` : ""}` : "chant read no graph, so no entry has a node",
    g.approve,
  ]
    .filter(Boolean)
    .join("\n");
  return { lines, tone: "quiet", title };
}

/** The legend: one row per bucket with its colour and how many entries it holds, and the entries that change nothing. */
export function overlayLegend(a) {
  if (!a || a.error || a.refusal) return [];
  const rows = BUCKETS.map((b) => ({ bucket: b.bucket, color: b.color, label: b.label, count: (a.counts && a.counts[b.bucket]) || 0, title: b.title }));
  if (a.unchanged) rows.push({ bucket: "unchanged", color: "var(--muted)", label: "no change (not drawn)", count: a.unchanged, title: "Entries the plan reads or leaves as they are." });
  return rows;
}

/** The tag above a card: its actions in words, "update", "2 create, delete". */
export function actionWords(actions) {
  const order = ["create", "update", "replace", "delete", "forget"];
  return order.filter((k) => actions && actions[k]).map((k) => (actions[k] === 1 ? k : `${actions[k]} ${k}`)).join(", ");
}

/** The entries on one card: its own, and on a counted block its instances' (#996). */
const onCard = (a, id) => a.entries.filter((e) => e.node === id || e.block === id);

/** The marks to draw: per node id, its colour, its tag and its tooltip. A
 * counted block's mark is the rollup of its instances' (#996), and each
 * instance card has its own. */
export function nodeMarks(a) {
  const out = {};
  if (!a || a.error || a.refusal || !a.nodes) return out;
  for (const [id, n] of Object.entries(a.nodes)) {
    const entries = onCard(a, id);
    out[id] = {
      bucket: n.bucket,
      color: bucketColor(n.bucket),
      tag: actionWords(n.actions),
      title: [`change set ${short(a.digest)} (preview, not applied):`, ...entries.map((e) => `${e.action} ${e.address}`)].join("\n"),
    };
  }
  return out;
}

const MAX_VALUE = 80;
/** One value as JSON, cut to a line. */
export function valueWords(v) {
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = String(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE - 3)}...` : s;
}

/** One attribute in words: "Versioning: before {...}, after {...}". */
export function attributeWords(t) {
  let what;
  if (t.sensitive) what = "sensitive, not shown";
  else {
    const parts = [];
    if ("before" in t) parts.push(`before ${valueWords(t.before)}`);
    if (t.unknown) parts.push("after: known after apply");
    else if ("after" in t) parts.push(`after ${valueWords(t.after)}`);
    what = parts.join(", ") || "changes";
  }
  return `${t.path}: ${what}${t.forcesReplacement ? " (forces replacement)" : ""}`;
}

/** One entry as lines: its action and address, then its type, disruption and fields where present. */
export function entryLines(e) {
  const facts = [e.type, e.disruption ? `disruption ${e.disruption}` : "", e.deposed ? `deposed ${e.deposed}` : ""].filter(Boolean).join(" · ");
  return { head: `${e.action} ${e.address}`, bucket: e.bucket, color: bucketColor(e.bucket), facts, fields: (e.attributes || []).map(attributeWords) };
}

/** The entries on one card, for the inspect pane. */
export function entriesFor(a, id) {
  if (!a || a.error || a.refusal || !a.entries) return [];
  return onCard(a, id).map(entryLines);
}

/**
 * The entries a reader would not see on the graph: those chant mapped to no
 * node, and those whose node this view does not draw (another lens, or a
 * member not on screen). `drawn` is the set of node ids on the canvas. An
 * instance whose card is not drawn is on the graph all the same when its
 * block card is: the block's rollup outline carries it (#996).
 */
export function offGraph(a, drawn) {
  if (!a || a.error || a.refusal || !a.entries) return { noNode: [], notDrawn: [] };
  return {
    noNode: a.entries.filter((e) => !e.node).map(entryLines),
    notDrawn: a.entries.filter((e) => e.node && drawn && !drawn.has(e.node) && !(e.block && drawn.has(e.block))).map((e) => ({ ...entryLines(e), node: e.node })),
  };
}

/** What the change set leaves out: members that failed to plan, and holes. */
export function gapLines(a) {
  if (!a || a.error || a.refusal || !a.gaps) return [];
  return a.gaps.map((m) => {
    if (m.status !== "planned") return { text: `${m.member} did not plan${m.error ? `: ${m.error}` : ""}, so its changes are not drawn`, title: "" };
    return { text: `${m.member}: ${plural(m.holes.length, "address", "addresses")} the plan could not read`, title: m.holes.map((h) => `${h.address}: ${h.reason}`).join("\n") };
  });
}

/** The heading over a card's entries in the inspect pane. */
export function inspectHeading(a) {
  return `change set ${short(a.digest)} (preview, not applied)`;
}
