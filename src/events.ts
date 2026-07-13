/**
 * Live-update plumbing (#3): a broadcaster + a source-file watcher. The server
 * fans "changed" events out over SSE so the SPA re-pulls the current view when the
 * served project's chant source changes. The same channel carries the live-drift
 * poll (#4).
 */
import { watch, existsSync } from "node:fs";
import { join } from "node:path";

/** Fan-out for server-sent events. Pure — unit-tested. */
export class Broadcaster {
  private listeners = new Set<(event: string) => void>();

  subscribe(fn: (event: string) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(event: string): void {
    // Copy first: a listener may unsubscribe during emit.
    for (const fn of [...this.listeners]) fn(event);
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
