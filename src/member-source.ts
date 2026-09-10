// Shared source identity for completed source reads and in-flight live reads.
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
const SKIP = new Set(["node_modules", "dist", ".git"]);

/** Hash the whole member root by relative path, mtime and size. Config can
 * choose source outside src/, so narrowing the walk would miss declarations.
 * Unreadable or empty roots return undefined and are never shared/cached.
 * Installed dependencies and generated dist/ output are deliberately excluded;
 * the caller separately keys on the resolved Chant compiler identity. */
export function memberSourceStamp(dir: string): string | undefined {
  const root = resolve(dir);
  const h = createHash("sha1");
  let any = false;
  const walk = (at: string): void => {
    // Sorted, so the same tree stamps the same however the filesystem enumerates it.
    const entries = readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const path = join(at, e.name);
      if (e.isDirectory()) {
        walk(path);
        continue;
      }
      if (!e.isFile()) continue; // sockets, fifos, dangling symlinks: nothing to stamp
      const st = statSync(path);
      h.update(`${relative(root, path)}\0${st.mtimeMs}\0${st.size}\n`);
      any = true;
    }
  };
  try {
    walk(root);
  } catch {
    return undefined;
  }
  return any ? h.digest("hex") : undefined;
}
