/**
 * #1059: read a directory as it was at a git revision, without touching the
 * working tree, so two revisions can be compared (src/graph-changed.ts).
 *
 * `git archive <rev>` writes the commit's tree into a temporary directory.
 * That reads objects only: no checkout, no worktree, no ref, no index change,
 * so it works from a shallow CI checkout as long as the two commits are
 * present (`git fetch --depth=1 origin <base>` brings a base in). A revision
 * that is not there is refused with that remedy, not read as empty.
 *
 * The copy is named after the repository folder (`<tmp>/<repo folder>/...`),
 * because a bare Terraform folder takes its member name from its folder name
 * (`bareFolderMemberName`) and every card id starts with it. A copy read
 * under a random name would move every id. The directory read is the same
 * path inside the copy, and the document's `origin.dir` and each card's file
 * are worked out against the real repository root, not the copy.
 *
 * Untracked files, ignored files and `node_modules` are not in an archive.
 * Directories named `node_modules` in the checkout are linked into the copy
 * (down to three levels) so a chant project reads with its installed chant.
 * `export-ignore` in a `.gitattributes` leaves a file out of an archive.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { documentOptions } from "./graph-document-context.ts";
import { graphDocument } from "./graph-formats.ts";
import type { GraphDocument } from "./graph-document.ts";
import { graphView, type GraphView, type GraphViewOptions } from "./graph-view.ts";
import type { ToDocumentOptions } from "./to-document.ts";

export class RevisionError extends Error {
  constructor(
    message: string,
    readonly remedy?: string,
  ) {
    super(message);
  }
}

export interface RevisionRange {
  base: string;
  head: string;
  /** `...`: compare from the merge base of the two, as a pull request does. */
  mergeBase: boolean;
}

/** `base..head` or `base...head`. An empty head is `HEAD`. */
export function parseRange(spec: string): RevisionRange | { error: string } {
  const m = /^(.+?)(\.\.\.?)(.*)$/.exec(spec);
  if (!m || !m[1]) return { error: `${JSON.stringify(spec)} is not a revision range: give <base>..<head>` };
  return { base: m[1], head: m[3] || "HEAD", mergeBase: m[2] === "..." };
}

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() || (r.error?.message ?? "") };
}

/** The repository root holding `dir`, or a RevisionError. */
export function gitRoot(dir: string): string {
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!r.ok || !r.out) throw new RevisionError(`${dir} is not inside a git repository`, "--changed reads two revisions of a git repository; run it in a clone");
  return realpathSync(r.out);
}

/** The commit `rev` names in the repository at `root`. */
export function resolveRevision(root: string, rev: string): string {
  const r = git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (!r.ok || !r.out) {
    const shallow = git(root, ["rev-parse", "--is-shallow-repository"]).out === "true";
    throw new RevisionError(
      `revision ${JSON.stringify(rev)} is not in this repository`,
      shallow
        ? `this is a shallow clone: fetch it first, e.g. git fetch --depth=1 origin ${rev}, then give its sha or origin/${rev}`
        : `fetch it first, e.g. git fetch origin ${rev}`,
    );
  }
  return r.out;
}

/** The two commits a range names. `...` compares from their merge base, which a shallow clone may not hold. */
export function resolveRange(root: string, range: RevisionRange): { base: string; head: string } {
  const head = resolveRevision(root, range.head);
  const base = resolveRevision(root, range.base);
  if (!range.mergeBase) return { base, head };
  const mb = git(root, ["merge-base", base, head]);
  if (!mb.ok || !mb.out) {
    throw new RevisionError(
      `no merge base between ${range.base} and ${range.head} in this clone`,
      "the clone is too shallow to find where they diverge: deepen it (git fetch --deepen=50), or give <base>..<head> to compare the two commits directly",
    );
  }
  return { base: mb.out, head };
}

/** Write the tree of commit `sha` under `into`, with `git archive`. */
function extract(root: string, sha: string, into: string): Promise<void> {
  return new Promise((done, fail) => {
    const archive = spawn("git", ["-C", root, "archive", "--format=tar", sha], { stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-C", into], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    archive.stderr.on("data", (d) => (err += d));
    tar.stderr.on("data", (d) => (err += d));
    archive.stdout.pipe(tar.stdin);
    let pending = 2;
    const finish = (code: number | null, who: string) => {
      if (code !== 0) return fail(new RevisionError(`${who} failed extracting ${sha.slice(0, 10)}: ${err.trim() || `exit ${code}`}`));
      if (--pending === 0) done();
    };
    archive.on("error", (e) => fail(new RevisionError(`git archive could not run: ${e.message}`)));
    tar.on("error", (e) => fail(new RevisionError(`tar could not run: ${e.message}`)));
    archive.on("close", (c) => finish(c, "git archive"));
    tar.on("close", (c) => finish(c, "tar"));
  });
}

/** Link the checkout's `node_modules` directories into the copy, down to `depth` levels, skipping `.git`. */
function linkNodeModules(real: string, copy: string, depth = 3): void {
  const mods = join(real, "node_modules");
  if (existsSync(mods) && !existsSync(join(copy, "node_modules"))) {
    try {
      symlinkSync(mods, join(copy, "node_modules"), "dir");
    } catch {
      /* a copy without the link reads with whatever chant the PATH has */
    }
  }
  if (depth === 0) return;
  let entries;
  try {
    entries = readdirSync(copy, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git") continue;
    linkNodeModules(join(real, e.name), join(copy, e.name), depth - 1);
  }
}

export interface RevisionRead {
  view: GraphView;
  /** What `toDocument` takes for the view: the copy's paths scrubbed back to the repository's. */
  options: ToDocumentOptions;
  /** The view as a document, built the way `graphDocument` builds it for a format. */
  document: GraphDocument;
}

export interface ReadAtOptions extends GraphViewOptions {
  behold: string;
  /** Keep `attrs.source`. */
  source?: boolean;
}

/**
 * Read `dir` as it is at commit `sha`. `dir` is a path in the checkout at
 * `root`; the same path inside the commit is read. A directory that does not
 * exist at the commit reads as an empty graph (`view` is undefined).
 */
export async function readAtRevision(root: string, dir: string, sha: string, opts: ReadAtOptions): Promise<RevisionRead | undefined> {
  const tmp = mkdtempSync(join(tmpdir(), "behold-rev-"));
  try {
    const copyRoot = join(tmp, basename(root));
    mkdirSync(copyRoot, { recursive: true });
    await extract(root, sha, copyRoot);
    const rel = relative(root, realpathSync(dir)).split(sep).join("/");
    const copyDir = resolve(copyRoot, rel);
    if (!existsSync(copyDir)) return undefined;
    linkNodeModules(root, copyRoot);
    const { behold, source, ...viewOpts } = opts;
    const view = await graphView(copyDir, viewOpts);
    const options = documentOptions({
      projectDir: copyDir,
      ...(view.read.workspace ? { workspace: view.read.workspace } : {}),
      behold,
      repoRoot: copyRoot,
      rev: sha,
    });
    return { view, options, document: graphDocument({ view, document: options, source: source === true }) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The document an absent directory reads as. */
export function emptyDocument(like: GraphDocument, sha: string): GraphDocument {
  return { ...like, origin: { ...like.origin, rev: sha }, nodes: [], edges: [], groups: [], notes: [] };
}
