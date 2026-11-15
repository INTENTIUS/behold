/**
 * behold#1071: where the single-file viewer (behold#1070) plugs into the
 * export. The viewer is one HTML file with the graph document inlined,
 * opening on the same view as `index.html`. Its build needs pinhole's release
 * (behold#1069), so this build carries none yet: `loadSingleFileViewer`
 * answers `undefined`, the export writes `graph.json` alone, and
 * `--single-file` says why it cannot run. When #1070 lands, it returns the
 * built viewer here and nothing else in the export changes.
 */
import type { GraphDocument } from "./graph-document.ts";

/** The file name the one-file viewer has inside a bundle. */
export const SINGLE_FILE_NAME = "behold.html";

/** The view the viewer opens on, as the bundle's manifest names it. */
export interface ViewerOpening {
  env?: string;
  zoom?: string;
}

export interface SingleFileViewer {
  /** The whole viewer as one HTML string, the document inlined. It must load from `file://` and fetch nothing. */
  render(input: { document: GraphDocument; opening: ViewerOpening; note?: string }): string;
}

/** The viewer this build carries, or `undefined` until behold#1070 builds one. */
export function loadSingleFileViewer(): SingleFileViewer | undefined {
  return undefined;
}
