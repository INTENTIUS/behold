import { cutDocument } from "../graph-cut.ts";
import type { GraphDocument } from "../graph-document.ts";

/**
 * `focus` cuts the document around the named boxes or cards with behold's own
 * cut (src/graph-cut.ts, the one `behold graph --around` and the Backstage tab
 * run), one hop out. A name is a box id (`stack:prod`), a bare box name
 * (`prod`) or a card id. A document that arrived already cut, or a focus that
 * names nothing in it, is drawn as it is.
 */
export function focusCut(doc: GraphDocument, focus: string[] | undefined): GraphDocument {
  if (!focus?.length || doc.cut.kind !== "whole") return doc;
  const ids = focus.flatMap((f) =>
    doc.nodes.some((n) => n.id === f) || doc.groups.some((g) => g.id === f) ? [f] : doc.groups.filter((g) => g.id.endsWith(`:${f}`)).map((g) => g.id),
  );
  if (!ids.length) return doc;
  const cut = cutDocument(doc, ids, { depth: 1 });
  return cut.ok ? cut.document : doc;
}

/** The card a view lights, so the rest dim. Undefined when no `node` is asked, so nothing dims. */
export function litCards(_doc: GraphDocument, view: { node?: string }): Set<string> | undefined {
  return view.node ? new Set([view.node]) : undefined;
}
