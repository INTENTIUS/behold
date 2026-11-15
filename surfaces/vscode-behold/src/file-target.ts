/**
 * Where a card's file is. The viewer sends `behold:select { id, kind, file }`
 * with `file` the repository-relative path the document names, and a webview
 * is not trusted with a path: a file is opened only when, resolved against the
 * repository root, it stays inside it. The line comes from the document's own
 * node, not from the message.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface SelectMessage {
  id: string;
  file: string | null;
}

export interface FileTarget {
  path: string;
  /** 1-based, when the document's node names one. */
  line?: number;
}

export function readSelect(data: unknown): SelectMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "behold:select" || typeof d.id !== "string") return null;
  return { id: d.id, file: typeof d.file === "string" && d.file ? d.file : null };
}

export function fileTarget(
  select: SelectMessage,
  repoRoot: string,
  nodes: ReadonlyArray<{ id: string; file?: string; line?: number }>,
): FileTarget | undefined {
  if (!select.file) return undefined;
  if (isAbsolute(select.file) || select.file.includes("\0")) return undefined;
  const root = resolve(repoRoot);
  const path = resolve(root, select.file);
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  const node = nodes.find((n) => n.id === select.id && n.file === select.file);
  return { path, ...(node?.line && node.line > 0 ? { line: node.line } : {}) };
}
