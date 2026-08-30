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

/**
 * Which substrate an `ApplyOp`'s declared `target` applies to (#117).
 *
 * chant's `ApplyTarget` is `"cloudformation" | "kubectl" | "arm"` (its temporal
 * lexicon, `op/activities/apply.ts`), and each names a transport that belongs to
 * exactly one lexicon. That is the whole mapping — behold does not infer a
 * substrate from anything else, because `target` is the only substrate fact an
 * Op author is already required to state.
 *
 * GCP is deliberately absent: chant has no GCP apply target yet, so a GCP Op
 * declares none and lands in the unscoped case `pickAutoSyncOps` handles.
 */
export const APPLY_TARGET_LEXICON: Readonly<Record<string, string>> = {
  cloudformation: "aws",
  kubectl: "k8s",
  // kustomize renders then applies through the same k8s pipeline
  // (chant#1548), so it scopes to the same lexicon. Note the auto-sync
  // wrinkle this creates on purpose: a kustomize Op AND a kubectl Op in one
  // project both exact-match `k8s`, and two exact matches decline — two Ops
  // claiming the k8s half genuinely is ambiguous.
  kustomize: "k8s",
  arm: "azure",
};

export interface OpInfo {
  name: string;
  kind: OpKind;
  /** The gate signal to send when a gated apply is waiting, if the Op declares one. */
  gate?: string;
  /** The environment the Op targets, if declared — so a post-op frame captures it. */
  env?: string;
  /**
   * The substrate this Op applies to (#117), derived from its declared `target`
   * via {@link APPLY_TARGET_LEXICON}. Undefined when the Op declares no target,
   * or declares one behold does not recognise.
   *
   * Undefined is the common case, not an edge: `ReconcileOp` takes no `target`
   * at all (it reads the estate and opens a PR — there is no transport to
   * choose), so every reconcile Op is unscoped. `pickAutoSyncOps` treats a
   * single unscoped Op as covering the estate, which is what keeps a
   * single-substrate project working exactly as it did.
   */
  substrate?: string;
  /** The project dir the Op lives in — where `chant run` executes it (#31: an Op
   * belongs to its own project, not necessarily the estate's primary). */
  dir: string;
  /** The emitted `dist/ops/<name>/op.json` (chant >= 0.50, chant#1289), when the
   * project has been built. Absent on an unbuilt project or an older chant —
   * the ops lens (#284, src/ops-lens.ts) is the only reader, and it simply
   * doesn't offer itself then. */
  irPath?: string;
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
      // Scraped the same way as `name:`/`signalName:`/`env:` above — declared
      // source, read as text. An unrecognised target maps to undefined rather
      // than to a guess (#117).
      const target = content.match(/\btarget:\s*["'`]([^"'`]+)["'`]/)?.[1];
      const substrate = target ? APPLY_TARGET_LEXICON[target] : undefined;
      const irPath = opIrPath(projectDir, name);
      out.push({
        name,
        kind: kindOf(content),
        dir: projectDir,
        ...(gate ? { gate } : {}),
        ...(env ? { env } : {}),
        ...(substrate ? { substrate } : {}),
        ...(existsSync(irPath) ? { irPath } : {}),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Where a built project keeps one Op's portable IR (chant >= 0.50, chant#1289).
 *
 * `dist/ops/<name>/` is the fixed location `chant build` writes and `chant run
 * --temporal` reads, independent of `--output` — so it is a path behold can
 * compute rather than discover. behold only ever reads it.
 */
export function opIrPath(projectDir: string, name: string): string {
  return join(projectDir, "dist", "ops", name, "op.json");
}

/** One emitted `op.json`, ready to read. */
export interface OpIrFile {
  /** The Op's name — the emitting directory, which is `OpConfig.name`. */
  name: string;
  /** The project that emitted it (#31: an Op belongs to its own project). */
  dir: string;
  path: string;
}

/**
 * Every emitted `op.json` across the served projects, in name order.
 *
 * Keyed on the emitted DIRECTORY rather than on {@link discoverOps}'s scrape of
 * `*.op.ts`: the whole point of the IR is that it is the declaration without
 * the TypeScript, and an Op whose source the scrape misses (a `name` built from
 * a const, a file outside `ops/`/`src/`/the root) still emits under its own
 * name. The scrape stays the source of an Op's kind/gate/env — `OpInfo.irPath`
 * joins the two the other way, for the delegated-write surface that already
 * reads it.
 *
 * A name collision across projects keeps the first seen, exactly as
 * {@link discoverEstateOps} does.
 */
export function discoverOpIrs(projectDirs: string[]): OpIrFile[] {
  const seen = new Set<string>();
  const out: OpIrFile[] = [];
  for (const dir of projectDirs) {
    const root = join(dir, "dist", "ops");
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (seen.has(name)) continue;
      const path = opIrPath(dir, name);
      if (!existsSync(path)) continue;
      seen.add(name);
      out.push({ name, dir, path });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Discover Ops across every served project (#31 multi-estate), each tagged with
 * its own `dir`. A name collision across projects keeps the first seen. */
export function discoverEstateOps(projectDirs: string[]): OpInfo[] {
  const seen = new Set<string>();
  const out: OpInfo[] = [];
  for (const dir of projectDirs) {
    for (const op of discoverOps(dir)) {
      if (seen.has(op.name)) continue;
      seen.add(op.name);
      out.push(op);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
