/**
 * behold#1058: the entry point of `@intentius/behold-graph`, the reader built
 * from this repository for hosts that cannot carry behold's whole install (a
 * CI action, an editor extension, an MCP tool). It holds the read, the view
 * the route draws, the output formats and the graph document, and nothing of
 * the server: no hono, no MCP SDK, no Kubernetes client
 * (src/read-graph-imports.test.ts walks this module, and
 * scripts/graph-package-check.sh installs the packed tarball and checks the
 * tree and its size).
 *
 * The package is built by `npm run build:graph` into packages/graph/dist.
 */
export { readGraph, ReadGraphError, type ReadGraphOptions, type ReadGraphResult } from "./read-graph.ts";
export { graphView, shapeEstate, viewNote, zoomOf, type GraphView, type GraphViewMeta, type GraphViewOptions } from "./graph-view.ts";
export { GRAPH_FORMATS, PENDING_FORMATS, graphDocument, graphFormat, graphSnapshot, type GraphFormat, type GraphFormatInput } from "./graph-formats.ts";
export { graphUsage, runGraph, type GraphCliIO } from "./graph-cli.ts";
export { toDocument, type DocumentMember, type GraphSnapshot, type ToDocumentOptions } from "./to-document.ts";
export { documentOptions, documentScrubber, repositoryRoot, type DocumentReadContext } from "./graph-document-context.ts";
export { cutDocument, type CutDirection, type CutDocumentOptions, type CutDocumentResult } from "./graph-cut.ts";
export { CHANGED_NODE_BUDGET, classifyChanged, cutChanged, type ChangeKind, type CutChangedOptions } from "./graph-changed.ts";
export { gitRoot, parseRange, readAtRevision, resolveRange, resolveRevision, RevisionError, type RevisionRange } from "./graph-revisions.ts";
export * from "./graph-document.ts";
export { escapeLabel, forgeComment, mermaidDiagram, rootTable, toMermaid, type ForgeComment, type MermaidOptions, type MermaidResult } from "./graph-mermaid.ts";
export { DEFAULT_FORGE, FORGES, FORGE_BUDGETS, isForge, type Forge, type ForgeBudget } from "./mermaid-budgets.ts";
