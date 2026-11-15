/**
 * #1066: what `toDocument` needs to know about the read that the graph IR
 * does not carry, worked out from the directory behold serves: the versions,
 * the served directory relative to its repository, each member's directory
 * and Terraform roots (so a card's file is named from the repository root),
 * and a scrubber that rewrites this machine's paths.
 *
 * It reads the disk (a walk up for `.git`, the root probe a Terraform member
 * already runs) and starts no process. It takes the served directories as an
 * argument and reads no module state but the one `estateMemberNames` already
 * reads for a loose `behold serve a b`.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { estateMemberNames } from "./estate.ts";
import { memberKindOf } from "./member-kind.ts";
import { checkoutRootDirs } from "./terraform-member.ts";
import type { DocumentMember, ToDocumentOptions } from "./to-document.ts";
import type { Workspace } from "./workspace.ts";

export interface DocumentReadContext {
  /** The served directory (the workspace root for a workspace). */
  projectDir: string;
  /** Every member directory of a loose estate (`behold serve a b c`). */
  projectDirs?: string[];
  workspace?: Pick<Workspace, "root" | "chant" | "members">;
  /** behold's own version. */
  behold: string;
  /** The revision read, when the read was at one. */
  rev?: string;
}

const posixRel = (from: string, to: string): string => relative(from, to).split(sep).join("/") || ".";

/** The nearest directory at or above `dir` holding `.git`, or `dir` itself when none does. */
export function repositoryRoot(dir: string): string {
  const start = resolve(dir);
  for (let d = start; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return start;
  }
}

function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** Terraform roots under a member, by name, relative to it. Empty for a member of another kind. */
function rootsOf(abs: string, kind: string | undefined): Record<string, string> | undefined {
  if (kind !== "terraform") return undefined;
  try {
    return Object.fromEntries(checkoutRootDirs(abs).map((r) => [r.name, r.dir]));
  } catch {
    return undefined;
  }
}

/**
 * Replace this machine's paths with repository-relative ones: each served
 * directory and the repository root (longest first, so a member inside the
 * root keeps its own path), then the home directory with `~` and the
 * temporary directory with `$TMPDIR`, for a scratch path a note quotes.
 */
export function documentScrubber(repoRoot: string, dirs: readonly string[], home: string = homedir(), tmp: string = tmpdir()): (text: string) => string {
  const pairs = new Map<string, string>();
  for (const d of [repoRoot, ...dirs]) {
    for (const p of [resolve(d), safeRealpath(d)]) if (p && p !== "/") pairs.set(p, posixRel(repoRoot, resolve(d)));
  }
  const ordered = [...pairs].sort((a, b) => b[0].length - a[0].length);
  const after: Array<[string, string]> = [];
  for (const p of [resolve(tmp), safeRealpath(tmp)]) if (p && p !== "/") after.push([p, "$TMPDIR"]);
  if (home && home !== "/") after.push([home, "~"]);
  after.sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = text;
    for (const [from, to] of ordered) {
      // `<dir>/x` becomes `x` under a root member, `<rel>/x` elsewhere.
      out = out.split(`${from}/`).join(to === "." ? "" : `${to}/`);
      out = out.split(from).join(to);
    }
    for (const [from, to] of after) out = out.split(from).join(to);
    return out;
  };
}

/** The options `toDocument` takes for a graph read from `ctx`'s directories. */
export function documentOptions(ctx: DocumentReadContext): ToDocumentOptions {
  const served = resolve(ctx.workspace?.root ?? ctx.projectDir);
  const repoRoot = repositoryRoot(served);
  const members: Record<string, DocumentMember> = {};
  const abs: string[] = [served];
  if (ctx.workspace) {
    for (const m of ctx.workspace.members) {
      if (!m.abs) continue;
      members[m.name] = { dir: posixRel(served, m.abs), ...optional(rootsOf(m.abs, m.kind)) };
      abs.push(m.abs);
    }
  } else {
    const dirs = (ctx.projectDirs?.length ?? 0) > 1 ? ctx.projectDirs! : [ctx.projectDir];
    // A single chant project's ids carry no member name; a bare Terraform
    // folder is composed as a one-member estate, so its ids do (#927).
    if (dirs.length > 1 || memberKindOf(dirs[0]!) === "terraform") {
      const names = estateMemberNames(dirs);
      dirs.forEach((d, i) => {
        members[names[i]!] = { dir: posixRel(served, resolve(d)), ...optional(rootsOf(resolve(d), memberKindOf(d))) };
        abs.push(resolve(d));
      });
    }
  }
  return {
    generator: { behold: ctx.behold, ...(ctx.workspace?.chant ? { chant: ctx.workspace.chant } : {}) },
    origin: { dir: posixRel(repoRoot, served), ...(ctx.rev ? { rev: ctx.rev } : {}) },
    members,
    scrub: documentScrubber(repoRoot, abs),
  };
}

const optional = (roots: Record<string, string> | undefined): { roots?: Record<string, string> } => (roots ? { roots } : {});
