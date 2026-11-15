/**
 * behold#1070: the graph.js a host writes next to the viewer, so the viewer
 * draws from `file://`, where a page can neither fetch nor receive a module.
 *
 * The viewer is built without the vendored icon table (most of the painter's
 * size), so graph.js carries the icons this document's cards wear, found by
 * painting it once here with the full table and recording what was used.
 */
import type { GraphDocument } from "../graph-document.ts";
import type { VendoredIcon } from "../icon-svg.ts";
import { recordIcons } from "../icon-packs.ts";
import { paintDocument } from "./paint.ts";

/** The vendored icons a document's cards wear, by the keys src/icons.generated.ts uses. */
export function documentIcons(doc: GraphDocument): Record<string, VendoredIcon> {
  return recordIcons(() => paintDocument(doc, { flatLimit: Number.POSITIVE_INFINITY })).icons;
}

/** JSON that is safe inside a `<script>`: no `</script>`, no line separators a parser reads as a line end. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** The text of graph.js for `doc`: the document and its icons as the two globals the viewer reads. */
export function graphScript(doc: GraphDocument, icons: Record<string, VendoredIcon> = documentIcons(doc)): string {
  return `window.__BEHOLD_ICONS__ = ${scriptJson(icons)};\nwindow.__BEHOLD_GRAPH__ = ${scriptJson(doc)};\n`;
}
