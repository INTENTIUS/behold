/**
 * behold#1073: what the `graph` tool of `behold mcp` reads and says.
 *
 * `readGraphCut` reads a directory into a `behold-graph/1` document, cut as
 * `behold graph` cuts it (`--around`, `--changed`: src/graph-cli.ts runs the
 * same calls), and `graphText` turns that into the text a model reads: counts,
 * the cut asked for, a Mermaid block when the cut fits, a per-root table when
 * it does not, and a link. The text holds no node list. The document itself
 * goes to the view through the app-only `graph_document` tool, so it never
 * enters the model's context.
 *
 * Unlike the other tools this one reads the directory in this process and
 * asks no serve: the document is a read of files and git objects, and a serve
 * is only needed for the link.
 */
import { cutChanged } from "./graph-changed.ts";
import { cutDocument, type CutDirection } from "./graph-cut.ts";
import type { GraphDocument } from "./graph-document.ts";
import { documentOptions } from "./graph-document-context.ts";
import { graphDocument } from "./graph-formats.ts";
import { emptyDocument, gitRoot, parseRange, readAtRevision, resolveRange, RevisionError } from "./graph-revisions.ts";
import { mermaidDiagram, rootTable } from "./graph-mermaid.ts";
import { FORGE_BUDGETS, type ForgeBudget } from "./mermaid-budgets.ts";
import { graphView } from "./graph-view.ts";
import { ReadGraphError } from "./read-graph.ts";

/** What a call of `graph` asks. `dir` is already inside the project. */
export interface GraphCutRequest {
  dir: string;
  /** Card or box ids to cut around (`behold graph --around`). */
  around?: string[];
  /** `<base>..<head>` (`behold graph --changed`). */
  changed?: string;
  depth?: number;
  direction?: CutDirection;
}

export interface GraphCutRead {
  /** The document after the cut. */
  document: GraphDocument;
  /** What the whole read held, before any cut. */
  whole: { cards: number; edges: number; roots: number };
}

/** A refusal with a message a model can act on: an id that is not there, a range that is not one. */
export class GraphToolError extends Error {
  constructor(
    message: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Boxes drawn at the top level: a Terraform root, a workspace member, a folder holding cards of its own. A reader's own note may count roots differently (the k8s.io infra folder: 49 roots, 50 boxes). */
export function rootCount(doc: GraphDocument): number {
  const ids = new Set(doc.groups.map((g) => g.id));
  return doc.groups.filter((g) => g.parent === undefined || !ids.has(g.parent)).length;
}

/**
 * The roots table names boxes by title, and the cut takes box ids (`stack:<key>`).
 * An id the document holds as neither a card nor a box, but that is a box's
 * title or a card's Terraform root, stands for that box, so a model can pass what it read in the table.
 */
export function namedBoxes(doc: GraphDocument, ids: readonly string[]): string[] {
  const known = new Set([...doc.nodes.map((n) => n.id), ...doc.groups.map((g) => g.id)]);
  return ids.flatMap((id) => {
    if (known.has(id)) return [id];
    const byTitle = doc.groups.filter((g) => g.title === id).map((g) => g.id);
    if (byTitle.length) return byTitle;
    // The table's Root column is a card's Terraform root when it has one.
    const byRoot = [...new Set(doc.nodes.filter((n) => n.detail__root === id && n.box !== undefined).map((n) => n.box!))];
    return byRoot.length ? byRoot : [id];
  });
}

/** Read `req.dir` and cut it. Throws `GraphToolError` for what the caller got wrong, and lets anything else through. */
export async function readGraphCut(req: GraphCutRequest, behold: string): Promise<GraphCutRead> {
  if (req.around && req.changed) throw new GraphToolError("around and changed are two cuts; give one");
  if (req.direction && !req.around) throw new GraphToolError("direction goes with around");
  try {
    if (req.changed) {
      const range = parseRange(req.changed);
      if ("error" in range) throw new GraphToolError(range.error);
      const root = gitRoot(req.dir);
      const { base, head } = resolveRange(root, range);
      // Below detail 3 a card holds no attributes, so an edited attribute would not show.
      const opts = { alike: false, detail: 3, behold, source: false };
      const headRead = await readAtRevision(root, req.dir, head, opts);
      if (!headRead) throw new GraphToolError(`${req.dir} does not exist at ${range.head} (${head.slice(0, 10)})`);
      const baseRead = await readAtRevision(root, req.dir, base, opts);
      const before = baseRead?.document ?? emptyDocument(headRead.document, base);
      const after = headRead.document;
      const document = cutChanged(before, after, {
        base: range.mergeBase ? `${range.base}...` : range.base,
        head: range.head,
        ...(req.depth !== undefined ? { depth: req.depth } : {}),
      });
      return { document, whole: { cards: after.nodes.length, edges: after.edges.length, roots: rootCount(after) } };
    }
    const view = await graphView(req.dir, { alike: true });
    const options = documentOptions({ projectDir: req.dir, ...(view.read.workspace ? { workspace: view.read.workspace } : {}), behold });
    const whole = graphDocument({ view, document: options, source: false });
    const counts = { cards: whole.nodes.length, edges: whole.edges.length, roots: rootCount(whole) };
    if (!req.around) return { document: whole, whole: counts };
    const r = cutDocument(whole, namedBoxes(whole, req.around), { ...(req.depth !== undefined ? { depth: req.depth } : {}), ...(req.direction ? { direction: req.direction } : {}) });
    if (!r.ok) throw new GraphToolError(r.error, { missing: r.missing });
    return { document: r.document, whole: counts };
  } catch (err) {
    if (err instanceof ReadGraphError) throw new GraphToolError(`${err.refusal.error} ${err.refusal.remedy}`.trim());
    if (err instanceof RevisionError) throw new GraphToolError(`${err.message}${err.remedy ? ` ${err.remedy}` : ""}`);
    throw err;
  }
}

/**
 * The model-facing budget. A Claude Code result over 10,000 tokens draws a
 * warning, and Mermaid runs near three characters to the token, so the whole
 * text stays under TEXT_CHARS and the diagram under half of it.
 */
export const TEXT_CHARS = 18_000;
export const MCP_MERMAID_BUDGET: ForgeBudget = {
  ...FORGE_BUDGETS.github,
  blockChars: 9_000,
  maxEdges: 120,
  commentChars: TEXT_CHARS,
  confirmed: false,
  basis: "behold#1073: a tool result that stays well under Claude Code's 10,000-token warning",
};

export interface GraphTextInput {
  /** The directory as the person would name it, relative to the project. */
  dir: string;
  request: Pick<GraphCutRequest, "around" | "changed" | "depth" | "direction">;
  read: GraphCutRead;
  /** The view's link, when a serve of this project runs; else the line that starts one. */
  link: { url: string; serving: boolean; command: string };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What was asked, in a clause. */
export function cutSentence(r: GraphTextInput["request"], doc: GraphDocument): string {
  const depth = r.depth ?? 1;
  if (r.around) {
    const way = r.direction === "up" ? "what they depend on" : r.direction === "down" ? "what depends on them" : "both ways";
    return `Cut around ${r.around.join(", ")}, ${plural(depth, "hop")} ${way}: ${plural(doc.nodes.length, "card")}, ${plural(doc.edges.length, "edge")}.`;
  }
  if (r.changed) return `Cut to what changed in ${r.changed}, with cards within ${plural(depth, "hop")}: ${plural(doc.nodes.length, "card")}, ${plural(doc.edges.length, "edge")}.`;
  return "The whole graph.";
}

/** The text a model reads. Holds counts, the cut, a diagram or a table, and a link; never the nodes. */
export function graphText(i: GraphTextInput): string {
  const { document: doc, whole } = i.read;
  const lines: string[] = [];
  lines.push(`behold graph of ${i.dir}: ${plural(whole.roots, "top-level box", "top-level boxes")} (roots and members), ${plural(whole.cards, "card")}, ${plural(whole.edges, "edge")} in all.`);
  lines.push(cutSentence(i.request, doc));
  for (const n of doc.notes.slice(0, 4)) lines.push(n.text.length > 240 ? `${n.text.slice(0, 237)}...` : n.text);
  const head = `${lines.join("\n")}\n\n`;
  const tail = i.link.serving
    ? `\nOpen it in behold: ${i.link.url}\n`
    : `\nNo behold serve of this project is running. Start \`${i.link.command}\` and open ${i.link.url}\n`;
  const room = TEXT_CHARS - head.length - tail.length;
  const d = mermaidDiagram(doc, { budget: { ...MCP_MERMAID_BUDGET, blockChars: Math.min(MCP_MERMAID_BUDGET.blockChars, Math.max(0, Math.floor(room / 2))) } });
  let body: string;
  if (d.text && d.hidden === 0 && d.text.length + 24 <= room) {
    body = `\`\`\`mermaid\n${d.text}\`\`\`\n`;
  } else {
    const hint = i.request.around ? "" : " Ask again with around set to a root or a card id to see one part as a diagram.";
    const intro = `The diagram does not fit in this answer (${plural(doc.nodes.length, "card")}), so the roots are listed with their card counts.${hint}\n\n`;
    body = `${intro}${rootTable(doc, Math.max(0, room - intro.length))}`;
  }
  return `${head}${body}${tail}`;
}

/** The view a serve opens for a cut: a card or box to look at, when the cut named one. A changed cut has no view key, so the link is the serve's own. */
export function viewQuery(request: GraphTextInput["request"], doc: GraphDocument): Record<string, string> {
  const first = request.around?.[0];
  if (!first) return {};
  return doc.nodes.some((n) => n.id === first) ? { node: first } : { focus: request.around!.join(",") };
}
