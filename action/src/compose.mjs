/**
 * What the action writes: the count line, the comment body and the job
 * summary. Pure functions over a changed-cut document (behold-graph/1, cut
 * kind `changed`) and the `behold` module the caller loaded, so tests run it
 * on a hand-made document.
 */

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The top-level group title a card is applied from, else its Terraform root or member. */
function rootOf(byBox, n) {
  return n.detail__root ?? (n.box !== undefined ? byBox.get(n.box) : undefined) ?? n.detail__member ?? "(no root)";
}

function topTitles(doc) {
  const groups = new Map(doc.groups.map((g) => [g.id, g]));
  const byBox = new Map();
  for (const g of doc.groups) {
    let at = g;
    for (let guard = 0; at.parent !== undefined && groups.has(at.parent) && guard <= doc.groups.length; guard++) at = groups.get(at.parent);
    byBox.set(g.id, at.title);
  }
  return byBox;
}

/** Counts a summary and a count line are written from. */
export function summarize(doc) {
  const counts = doc.cut?.counts ?? { added: 0, removed: 0, changed: 0 };
  const byBox = topTitles(doc);
  const roots = new Set();
  for (const n of doc.nodes) if (n.diff !== "neighbour") roots.add(rootOf(byBox, n));
  // A cut folded to a table has no cards; its changed boxes are the table's rows.
  if (doc.nodes.length === 0) for (const note of doc.notes) if (note.kind === "changed-table" && note.box) roots.add(byBox.get(note.box) ?? note.box);
  const neighbours = doc.nodes.filter((n) => n.diff === "neighbour").length;
  const total = counts.added + counts.removed + counts.changed;
  return { added: counts.added, removed: counts.removed, changed: counts.changed, total, neighbours, roots: roots.size, folded: doc.cut?.folded };
}

/** "4 changed, 9 neighbours, in 2 roots". Added and removed are named when there are any. */
export function countLine(s) {
  if (s.total === 0) return "Nothing changed";
  const parts = [];
  if (s.changed) parts.push(`${s.changed} changed`);
  if (s.added) parts.push(`${s.added} added`);
  if (s.removed) parts.push(`${s.removed} removed`);
  if (s.neighbours) parts.push(plural(s.neighbours, "neighbour", "neighbours"));
  const roots = s.roots ? `, in ${plural(s.roots, "root", "roots")}` : "";
  return `${parts.join(", ")}${roots}`;
}

const cell = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/`/g, "'");

/** The table a cut folded to carries: one line per box, from the cut's own notes. */
function foldedTable(doc) {
  const rows = doc.notes.filter((n) => n.kind === "changed-table").map((n) => `| ${cell(n.text)} |\n`);
  return `| Changed, by box |\n| --- |\n${rows.join("")}`;
}

/**
 * The diagram or table for a document, with the marker line and the count line
 * in front. `kind` says which it was: `diagram`, `table`, or `empty` when
 * nothing changed.
 */
export function commentBody(behold, doc, { marker, footer = "", forge = "github" }) {
  const budget = behold.FORGE_BUDGETS[forge].commentChars;
  const head = `<!-- ${marker} -->\n`;
  const s = summarize(doc);
  if (s.total === 0) return { text: `${head}**behold:** ${countLine(s)} between ${doc.cut?.base ?? "the base"} and ${doc.cut?.head ?? "the head"}.\n${footer}`, kind: "empty", summary: s };
  const line = `**behold:** ${countLine(s)}\n\n`;
  const notes = doc.notes
    .filter((n) => n.kind === "changed-folded" || n.kind === "changed-detail")
    .map((n) => `> ${cell(n.text)}\n`)
    .join("");
  if (doc.nodes.length > 0) {
    const fc = behold.forgeComment(doc, { forge, marker });
    if (fc.kind === "diagram") {
      const fence = fc.text.slice(fc.text.indexOf("```mermaid"));
      const text = `${head}${line}${fence}${notes ? `\n${notes}` : ""}${footer}`;
      if (text.length < budget) return { text, kind: "diagram", summary: s };
    }
    const table = behold.rootTable(doc, budget - head.length - line.length - footer.length - notes.length - 64);
    return { text: `${head}${line}${table}${notes ? `\n${notes}` : ""}${footer}`, kind: "table", summary: s };
  }
  return { text: `${head}${line}${foldedTable(doc)}${notes ? `\n${notes}` : ""}${footer}`, kind: "table", summary: s };
}

/** The job summary: the comment body without its marker, and the artifact links. */
export function jobSummary(body, { artifacts = [], fork = false, commentNote = "" } = {}) {
  const lines = body.text.replace(/^<!--[^>]*-->\n/, "").trimEnd();
  const links = artifacts.filter((a) => a.url).map((a) => `- [${a.label}](${a.url})`);
  const out = [`## behold: what this pull request changes`, "", lines, ""];
  if (links.length) out.push("Artifacts:", "", ...links, "");
  if (fork) out.push("This run is from a fork, so the token is read-only and the comment is posted by the workflow_run job instead.", "");
  if (commentNote) out.push(commentNote, "");
  return `${out.join("\n")}\n`;
}

export const SUMMARY_LIMIT_BYTES = 1024 * 1024;
