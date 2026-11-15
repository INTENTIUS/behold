import type { GraphDocument } from "./behold.ts";
import { documentIcons, documentOptions, graphDocument, graphView, repositoryRoot } from "./behold.ts";

export interface FolderRead {
  document: GraphDocument;
  icons: ReturnType<typeof documentIcons>;
  /** What a card's `file` is relative to. */
  repoRoot: string;
}

/** Read `dir` into a behold-graph/1 document and the icons its cards wear. Starts the staged chant as a child of this process. */
export async function readFolder(dir: string, version: string): Promise<FolderRead> {
  const view = await graphView(dir, { alike: true });
  const document = graphDocument({
    view,
    document: documentOptions({ projectDir: dir, ...(view.read.workspace ? { workspace: view.read.workspace } : {}), behold: version }),
    source: false,
  });
  return { document, icons: documentIcons(document), repoRoot: repositoryRoot(dir) };
}
