/**
 * Live-update plumbing (#3): a broadcaster + a source-file watcher. The server
 * fans "changed" events out over SSE so the SPA re-pulls the current view when the
 * served project's chant source changes. The same channel carries the live-drift
 * poll (#4).
 */
import { watch, existsSync } from "node:fs";
import { join } from "node:path";

/** Fan-out for server-sent events. Each message is a typed event (`changed`,
 * `frames`, `op`) with optional data (an op-output line). Pure — unit-tested. */
export class Broadcaster {
  private listeners = new Set<(type: string, data: string) => void>();

  subscribe(fn: (type: string, data: string) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(type: string, data = ""): void {
    // Copy first: a listener may unsubscribe during emit.
    for (const fn of [...this.listeners]) fn(type, data);
  }

  get size(): number {
    return this.listeners.size;
  }
}

const IGNORE = /(^|[\\/])(node_modules|dist|\.git)([\\/]|$)/;

/**
 * Watch a chant project's source for `.ts` edits (debounced) and call `onChange`.
 * Watches `<projectDir>/src` when present — so we don't walk `node_modules` — else
 * the project root. Returns a stop function. Recursive `fs.watch` (Node 20+, and
 * behold targets Node 24), so no watcher dependency.
 */
export function watchSource(projectDir: string, onChange: () => void, debounceMs = 200): () => void {
  const dir = existsSync(join(projectDir, "src")) ? join(projectDir, "src") : projectDir;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(dir, { recursive: true }, (_event, file) => {
    const name = typeof file === "string" ? file : "";
    if (!name || IGNORE.test(name) || !name.endsWith(".ts")) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

/**
 * {@link watchSource} across every estate member (#297). Before this, `serve a b
 * c` watched only the primary's src/ — an edit in any other member never fired.
 * One watcher (and one debounce timer) per member, so a burst of edits in one
 * member can't swallow another's event, and `onChange` carries the member dir
 * that actually changed. Returns one stop function covering them all.
 */
export function watchSources(
  projectDirs: readonly string[],
  onChange: (dir: string) => void,
  debounceMs = 200,
): () => void {
  const stops = projectDirs.map((dir) => watchSource(dir, () => onChange(dir), debounceMs));
  return () => {
    for (const stop of stops) stop();
  };
}
