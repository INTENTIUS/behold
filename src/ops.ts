/**
 * Delegated writes (#7 Sync / #8 Adopt). behold discovers the project's committed
 * Ops (`*.op.ts`) and triggers them — `chant run <name>` on the executor. behold
 * holds no apply creds; it triggers Ops you wrote. Two gestures map to two Op
 * kinds: **apply** (`ApplyOp`, code→cloud) and **reconcile** (`ReconcileOp`,
 * cloud→code PR).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type OpKind = "apply" | "reconcile" | "audit" | "op";

export interface OpInfo {
  name: string;
  kind: OpKind;
  /** The gate signal to send when a gated apply is waiting, if the Op declares one. */
  gate?: string;
  /** The environment the Op targets, if declared — so a post-op frame captures it. */
  env?: string;
}

function kindOf(content: string): OpKind {
  if (/\bApplyOp\b/.test(content)) return "apply";
  if (/\bReconcileOp\b/.test(content)) return "reconcile";
  if (/AuditOp\b/.test(content)) return "audit";
  return "op";
}

/** Discover the project's Ops by scanning `*.op.ts` (in `ops/` and the root) for
 * the Op `name`, its kind, and any declared gate signal. Filename-agnostic — reads
 * the declared `name:`. */
export function discoverOps(projectDir: string): OpInfo[] {
  const seen = new Set<string>();
  const out: OpInfo[] = [];
  for (const sub of ["ops", "src", "."]) {
    const dir = join(projectDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".op.ts")) continue;
      const content = readFileSync(join(dir, f), "utf8");
      const name = content.match(/name:\s*["'`]([^"'`]+)["'`]/)?.[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const gate = content.match(/signalName:\s*["'`]([^"'`]+)["'`]/)?.[1];
      const env = content.match(/\benv:\s*["'`]([^"'`]+)["'`]/)?.[1];
      out.push({ name, kind: kindOf(content), ...(gate ? { gate } : {}), ...(env ? { env } : {}) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
