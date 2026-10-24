/**
 * Which forge deploys an environment (#165, #61, #470). The fact is the
 * member's: `chant.config.ts` declares `{ name: "prod", executor: { forge,
 * workflow } }` on the environment entry, and chant prints it on every
 * `components[].environments[]` row of `chant workspace graph --composites`
 * (chant#4402, floor `EXECUTOR_CHANT_FLOOR`). behold reads it there and nowhere
 * else: not from `.behold.json` (retired), and never from the name of a
 * generated `chant-components-<env>` workflow (maintainer ruling, 2026-10-23).
 *
 * Fail-closed where chant says it could not tell: `executor-config-unreadable`
 * keeps the env designated, with the reason, so local Deploy stays off. An
 * env with no row, a chant below the floor, or a read that fails is "none
 * declared", which is how an env with no designation always behaved.
 */
import { dirname, relative, resolve } from "node:path";
import { rootReader, type WorkspaceDocument, type WorkspaceReader } from "./workspace-reader.ts";
import { hasDeclaration, servedWorkspace, workspaceMemberOf } from "./workspace.ts";
import { EXECUTOR_CHANT_FLOOR } from "./chant-floors.ts";

export { EXECUTOR_CHANT_FLOOR };

/** A forge workflow that deploys an env, or the reason behold cannot honour what chant reports. */
export type ExecutorDesignation = { forge: string; workflow: string } | { invalid: string };

/** member name -> env -> designation. A member's `""` key holds every row, for a read with no member filter. */
export type ExecutorTable = Map<string, Record<string, ExecutorDesignation>>;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The designations a `workspace graph --composites` document carries, per member. Pure. */
export function executorsFromComposites(doc: WorkspaceDocument): ExecutorTable {
  const out: ExecutorTable = new Map();
  const components = Array.isArray(doc.components) ? doc.components : [];
  for (const c of components) {
    if (!isRecord(c) || typeof c.member !== "string" || !Array.isArray(c.environments)) continue;
    for (const e of c.environments) {
      if (!isRecord(e) || typeof e.name !== "string" || !isRecord(e.executor)) continue;
      const x = e.executor;
      let d: ExecutorDesignation | undefined;
      if (typeof x.forge === "string" && typeof x.workflow === "string") d = { forge: x.forge, workflow: x.workflow };
      else if (isRecord(x.reason) && x.reason.code === "executor-config-unreadable") {
        d = { invalid: `chant could not read ${c.member}'s chant.config.ts to tell whether ${e.name} deploys through a forge${typeof x.reason.message === "string" ? ` (${x.reason.message})` : ""}` };
      }
      if (!d) continue;
      const rows = out.get(c.member) ?? {};
      // Every component of a member carries the member's executor for the env; an unreadable config wins over a declaration.
      if (!rows[e.name] || "invalid" in d) rows[e.name] = d;
      out.set(c.member, rows);
    }
  }
  return out;
}

type Source = (root: string, member: string | undefined) => Promise<WorkspaceDocument>;

let source: Source | undefined;
/** Test seam: replace the chant read with a fixture document. `undefined` restores chant. */
export function setExecutorSource(s: Source | undefined): void {
  source = s;
  resetExecutorCache();
}

const defaultSource = (root: string, member: string | undefined, reader: WorkspaceReader = rootReader(root)): Promise<WorkspaceDocument> =>
  reader.read("graph", ["--composites", ...(member ? ["--member", member] : [])]);

const cache = new Map<string, Promise<Record<string, ExecutorDesignation>>>();

/** Drop the per-directory cache: a test that rewrites a config, or a served-project switch. */
export function resetExecutorCache(dir?: string): void {
  if (dir === undefined) cache.clear();
  else cache.delete(resolve(dir));
}

/** The nearest directory at or above `dir` that holds a workspace declaration. */
function declaringRoot(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (hasDeclaration(d)) return d;
    if (dirname(d) === d) return undefined;
  }
}

/**
 * The designations of the project at `dir`, by env. A member of the served
 * workspace is read from the workspace root, filtered to its name. Any other
 * directory is read from where it stands, which chant resolves to the
 * workspace above it or a one-member scratch workspace; inside a declared
 * workspace, only the member at `dir` counts, so a sibling's designation is
 * never taken for it. A read chant refuses (not a workspace, below the floor,
 * no chant) yields none. Cached per directory for the process, like the
 * config it reads.
 */
export function executorsOf(dir: string): Promise<Record<string, ExecutorDesignation>> {
  const key = resolve(dir);
  let hit = cache.get(key);
  if (!hit) {
    const member = workspaceMemberOf(key);
    const ws = servedWorkspace();
    const root = member && ws ? ws.root : key;
    hit = (async () => {
      try {
        const doc = await (source ?? defaultSource)(root, member?.name);
        const table = executorsFromComposites(doc);
        if (member) return table.get(member.name) ?? {};
        const declared = declaringRoot(key);
        if (declared) {
          const rel = relative(declared, key) || ".";
          const m = (Array.isArray(doc.members) ? doc.members : []).find((x) => isRecord(x) && x.dir === rel);
          return isRecord(m) && typeof m.name === "string" ? (table.get(m.name) ?? {}) : {};
        }
        return Object.assign({}, ...table.values()) as Record<string, ExecutorDesignation>;
      } catch {
        return {};
      }
    })();
    cache.set(key, hit);
  }
  return hit;
}

/** A member's executor designation for one env, read from THAT member's own config (an Op belongs to the directory that declares it, `OpInfo.dir`). */
export async function executorDesignation(dir: string, env: string | undefined): Promise<ExecutorDesignation | undefined> {
  if (!env) return undefined;
  return (await executorsOf(dir))[env];
}
