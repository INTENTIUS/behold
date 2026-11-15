/**
 * The one place the extension reaches into the behold repository. Everything
 * else in this folder imports from here, so moving the extension to its own
 * repository changes this file and nothing else:
 *
 * - `@intentius/behold-graph` (the reader, `graphView`, `graphDocument`) comes
 *   from the published package instead of ../../../src.
 * - `documentIcons` is the painter's own record of the vendored icons a
 *   document's cards wear (src/viewer/graph-script.ts). The viewer ships
 *   without the icon table, so the host sends the icons its document uses.
 *   It has no package of its own yet; the move either exports it from
 *   `@intentius/behold-graph` or the extension vendors it.
 */
export { documentOptions, graphDocument, graphView, ReadGraphError, repositoryRoot } from "../../../src/graph-package.ts";
export type { GraphDocument } from "../../../src/graph-package.ts";
export { documentIcons } from "../../../src/viewer/graph-script.ts";
