/**
 * Per-commit snapshots of a published view (#510).
 *
 * `behold export --publish s3://<bucket>/<prefix>/views/<name>` used to put
 * the bundle straight under `views/<name>/`, so every run of the estate job
 * replaced the last one and nothing older could be opened. The layout is now:
 *
 *   views/<name>/<commit>/...    one bundle per commit, as publishBundle writes it
 *   views/<name>/history.json    newest first: [{commit, at, project, generated}]
 *   views/<name>/latest.json     {commit}
 *   views/<name>/index.html      a no-cache page that opens <latest>/index.html
 *
 * The order keeps a reader from following a pointer to something half
 * written: the commit's files (index.html last, as #500 has it), then
 * history.json, then latest.json, then the root index.html. Then, best
 * effort, the commits `--keep` dropped from history.json are deleted file by
 * file as each one's own manifest.json names them, never with a list call,
 * and never outside `views/<name>/`. A view published before this layout
 * (files directly under `views/<name>/`) is left where it is; only its
 * index.html becomes the redirect page.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_CACHE, publishBundle } from "./export.ts";
import { S3Error, type S3Object } from "./s3-object.ts";

/** `--keep`'s default: how many commits history.json holds. */
export const DEFAULT_KEEP = 30;

/** A report key's base from a commit's bundle at `<prefix>/views/<name>/<commit>/`: `../../../` is the prefix. */
export const SNAPSHOT_REPORTS_BASE = "../../../";

/** A commit as a key segment: lowercase hex, abbreviated or whole. */
export const COMMIT = /^[0-9a-f]{7,64}$/;

/**
 * The commit a publish files the view under: `given` (`--commit`), or the
 * HEAD of the git checkout at `dir`. `at` is the commit's committer date when
 * git can name it. An error says what to pass instead.
 */
export function resolveCommit(dir: string, given?: string): { sha: string; at?: string } | { error: string } {
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let sha: string;
  if (given !== undefined) {
    sha = given.toLowerCase();
    if (!COMMIT.test(sha)) return { error: `--commit takes a commit's hex digits (7 to 64 of them), not ${given}` };
  } else {
    try {
      sha = git("rev-parse", "HEAD").toLowerCase();
    } catch {
      return { error: `--publish files the view under the served checkout's commit, and ${dir} is not a git checkout with a commit: pass --commit <sha>` };
    }
    if (!COMMIT.test(sha)) return { error: `git rev-parse HEAD in ${dir} answered ${sha}: pass --commit <sha>` };
  }
  try {
    const at = git("show", "-s", "--format=%cI", `${sha}^{commit}`);
    return at ? { sha, at: new Date(at).toISOString() } : { sha };
  } catch {
    return { sha };
  }
}

/** One row of history.json. */
export interface HistoryEntry {
  commit: string;
  /** When the commit was made (its committer date), or the export time when that is unknown. */
  at: string;
  /** The exported project, as the bundle's manifest names it. */
  project: string;
  /** When the bundle was captured. */
  generated: string;
}

/** What a snapshot publish did. */
export interface SnapshotPublished {
  commit: string;
  /** Files uploaded under `<prefix>/<commit>/`, not counting the three pointer files. */
  files: number;
  /** Keys this publish deleted: stale snapshots of the same commit, then the files of pruned commits. */
  removed: string[];
  /** Commits dropped from history.json by `--keep`. */
  dropped: string[];
  /** Of those, the commits whose files were deleted. */
  pruned: string[];
  /** How many commits history.json now holds. */
  history: number;
  warnings: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The rows of a history.json, in its order; anything that is not a row with a commit is dropped. */
export function parseHistory(text: string): HistoryEntry[] {
  const doc: unknown = JSON.parse(text);
  if (!Array.isArray(doc)) throw new Error("history.json is not an array");
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return doc
    .filter((e): e is Record<string, unknown> => isRecord(e) && typeof e.commit === "string" && COMMIT.test(e.commit))
    .map((e) => ({ commit: e.commit as string, at: str(e.at), project: str(e.project), generated: str(e.generated) }));
}

/** `entry` on top of `old` (a republished commit moves up rather than appearing twice), cut to `keep`. */
export function nextHistory(old: HistoryEntry[], entry: HistoryEntry, keep: number): { history: HistoryEntry[]; dropped: string[] } {
  const all = [entry, ...old.filter((e) => e.commit !== entry.commit)];
  const seen = new Set<string>();
  const unique = all.filter((e) => (seen.has(e.commit) ? false : (seen.add(e.commit), true)));
  return { history: unique.slice(0, keep), dropped: unique.slice(keep).map((e) => e.commit) };
}

/** A path inside a commit's bundle, as a manifest may name one: relative, no empty, `.` or `..` segment. */
const BUNDLE_PATH = /^[A-Za-z0-9=_.@+-]+(\/[A-Za-z0-9=_.@+-]+)*$/;
const insideBundle = (f: unknown): f is string => typeof f === "string" && BUNDLE_PATH.test(f) && !f.split("/").some((p) => p === "." || p === "..");

/**
 * The files a commit's manifest.json names, in the order they are deleted:
 * index.html first, so the view stops opening before its parts go, and
 * manifest.json last, so an interrupted prune can be finished from it.
 */
export function commitFiles(manifestText: string): string[] {
  const doc: unknown = JSON.parse(manifestText);
  if (!isRecord(doc)) return ["manifest.json"];
  const listed = Array.isArray(doc.files) ? doc.files.filter(insideBundle) : [];
  const snaps = isRecord(doc.keyToFile) ? Object.values(doc.keyToFile).filter(insideBundle) : [];
  const rest = [...new Set([...listed, ...snaps])].filter((f) => f !== "index.html" && f !== "manifest.json").sort();
  return ["index.html", ...rest, "manifest.json"];
}

/** The root index.html: reads latest.json and opens that commit's view, keeping the query and the fragment. */
export function redirectPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>behold</title>
<script>
(function () {
  var path = location.pathname;
  var base = /\\/$|\\.html?$/.test(path) ? "" : path.split("/").pop() + "/";
  fetch(base + "latest.json", { cache: "no-cache" })
    .then(function (r) { if (!r.ok) throw new Error("latest.json: " + r.status); return r.json(); })
    .then(function (l) {
      if (!l || typeof l.commit !== "string" || !${COMMIT}.test(l.commit)) throw new Error("latest.json names no commit");
      location.replace(base + l.commit + "/index.html" + location.search + location.hash);
    })
    .catch(function (e) { document.getElementById("m").textContent = "No published view to open: " + e.message; });
})();
</script>
</head>
<body style="font: 13px ui-monospace, monospace; padding: 16px">
<p id="m">Opening the newest view...</p>
<noscript><p>This page opens the newest view named in latest.json and needs JavaScript.</p></noscript>
</body>
</html>
`;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const denied = (e: unknown) => e instanceof S3Error && (e.status === 403 || e.code === "AccessDenied");

/**
 * Publish the bundle in `outDir` as `commit` under `target.prefix` (a
 * `views/<name>` directory, as publishTarget checked), then point
 * history.json, latest.json and index.html at it, then prune past `keep`.
 */
export async function publishSnapshot(
  outDir: string,
  target: { bucket: string; prefix: string },
  commit: { sha: string; at?: string },
  client: Pick<S3Object, "put" | "get" | "delete">,
  opts: { keep?: number; project?: string } = {},
): Promise<SnapshotPublished> {
  const sha = commit.sha.toLowerCase();
  if (!COMMIT.test(sha)) throw new Error(`a commit is 7 to 64 hex digits, not ${commit.sha}`);
  const keep = opts.keep ?? DEFAULT_KEEP;
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`--keep takes a whole number of at least 1, not ${keep}`);
  const at = (f: string) => `${target.prefix}/${f}`;

  const local = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as { capturedAt?: string; projectDir?: string };
  const generated = local.capturedAt ?? new Date().toISOString();
  const entry: HistoryEntry = { commit: sha, at: commit.at ?? generated, project: opts.project ?? local.projectDir ?? "", generated };

  // 1. The commit's own files, index.html last (publishBundle's order and sweep, one level down).
  const bundle = await publishBundle(outDir, { bucket: target.bucket, prefix: at(sha) }, client);
  const warnings = [...bundle.warnings];
  const removed = [...bundle.removed];

  // 2. history.json: one GET of the old one, no list call.
  let old: HistoryEntry[] = [];
  try {
    const text = await client.get(at("history.json"));
    if (text !== undefined) old = parseHistory(text);
  } catch (e) {
    const note = e instanceof S3Error && e.status === 403 ? " (S3 answers 403 for a missing object too when the credentials lack s3:ListBucket)" : "";
    warnings.push(`the previous history.json could not be read, so it starts again from ${sha} and older commits are left in place: ${message(e)}${note}`);
  }
  const { history, dropped } = nextHistory(old, entry, keep);
  await client.put(at("history.json"), JSON.stringify(history, null, 2) + "\n", "application/json", NO_CACHE);

  // 3. latest.json, then 4. the root index.html.
  await client.put(at("latest.json"), JSON.stringify({ commit: sha }) + "\n", "application/json", NO_CACHE);
  await client.put(at("index.html"), redirectPage(), "text/html; charset=utf-8", NO_CACHE);

  // 5. Prune, best effort: each dropped commit's files as its manifest names them.
  const pruned: string[] = [];
  prune: for (const c of dropped) {
    if (c === sha) continue;
    let files: string[];
    try {
      const text = await client.get(at(`${c}/manifest.json`));
      if (text === undefined) {
        pruned.push(c);
        continue;
      }
      files = commitFiles(text);
    } catch (e) {
      warnings.push(`${c} left history.json but its files were left in s3://${target.bucket}/${at(c)}/: its manifest.json could not be read: ${message(e)}`);
      continue;
    }
    for (const f of files) {
      try {
        await client.delete(at(`${c}/${f}`));
        removed.push(at(`${c}/${f}`));
      } catch (e) {
        const left = dropped.slice(dropped.indexOf(c)).join(", ");
        warnings.push(
          denied(e)
            ? `commits past --keep ${keep} left history.json but their files were left in s3://${target.bucket}/${target.prefix}/ (${left}): deleting them needs s3:DeleteObject on that prefix, which these credentials lack`
            : `commits past --keep ${keep} left history.json but their files were left in s3://${target.bucket}/${target.prefix}/ (${left}): ${message(e)}`,
        );
        break prune;
      }
    }
    pruned.push(c);
  }
  return { commit: sha, files: bundle.files, removed, dropped, pruned, history: history.length, warnings };
}
