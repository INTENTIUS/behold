/**
 * behold#916 (ruled on #907, decision 4): how `behold mcp` finds the serve of
 * its project.
 *
 * Every `behold serve` (and `preview`, `demo`, which start the same server)
 * writes one file, `<os.tmpdir()>/behold/serves/<pid>.json`, holding
 * `{url, pid, projectDir, version, startedAt}`. It is rewritten when the
 * served project switches and removed at exit. A file whose pid is dead is
 * ignored (and swept). Nothing is written in the served project: the
 * registry sits beside the Terraform scratch project under the OS temp
 * directory, and the directory is the user's own (mode 0700, files 0600, a
 * file another user owns is never read).
 *
 * `BEHOLD_SERVES_DIR` moves the registry; the tests use it.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, resolve } from "node:path";

export interface ServeEntry {
  url: string;
  pid: number;
  /** The served project's directory, realpath'd: a workspace's root, or the primary member. */
  projectDir: string;
  version: string;
  startedAt: string;
}

/** Where the entries live. */
export function servesDir(): string {
  return process.env.BEHOLD_SERVES_DIR || join(tmpdir(), "behold", "serves");
}

/** A directory's realpath, or the resolved path when it can't be read. */
export function realDir(dir: string): string {
  try {
    return realpathSync(resolve(dir));
  } catch {
    return resolve(dir);
  }
}

/** Whether `pid` is a live process this user can see. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const entryFile = (pid: number): string => join(servesDir(), `${pid}.json`);

/**
 * Write this process's entry. Best-effort: a temp dir that can't be written
 * never fails a serve, and the serve stays reachable by --url/--port.
 */
export function writeServeEntry(e: Omit<ServeEntry, "projectDir"> & { projectDir: string }): void {
  const dir = servesDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = entryFile(e.pid);
    writeFileSync(file, JSON.stringify({ ...e, projectDir: realDir(e.projectDir) }, null, 2) + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

/** Remove this process's entry. Best-effort, and safe to call twice. */
export function removeServeEntry(pid = process.pid): void {
  try {
    rmSync(entryFile(pid), { force: true });
  } catch {
    /* best-effort */
  }
}

const isEntry = (v: unknown): v is ServeEntry => {
  const e = v as ServeEntry;
  return !!e && typeof e.url === "string" && Number.isInteger(e.pid) && typeof e.projectDir === "string" && typeof e.version === "string" && typeof e.startedAt === "string";
};

/**
 * Every live serve's entry, newest first. An entry whose pid is dead is
 * removed; one that isn't JSON, or that another user owns, is skipped.
 */
export function listServes(alive: (pid: number) => boolean = pidAlive): ServeEntry[] {
  const dir = servesDir();
  if (!existsSync(dir)) return [];
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const out: ServeEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = join(dir, name);
    try {
      if (uid !== undefined && statSync(file).uid !== uid) continue;
      const e = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!isEntry(e) || `${e.pid}.json` !== name) continue;
      if (!alive(e.pid)) {
        rmSync(file, { force: true });
        continue;
      }
      out.push(e);
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Whether `inner` is `outer` or a directory under it. */
export function within(outer: string, inner: string): boolean {
  const r = relative(outer, inner);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** The newest live serve of `projectDir` (or of a directory holding it). */
export function findServe(projectDir: string, alive?: (pid: number) => boolean): ServeEntry | undefined {
  const want = realDir(projectDir);
  return listServes(alive).find((e) => within(e.projectDir, want));
}
