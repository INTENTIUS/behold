/**
 * The GitOps sources a cluster's objects name (behold#1123): the repository
 * and the path an Argo CD Application or a Flux Kustomization deploys from,
 * and the local clone that holds each, for src/joined-read.ts to read as a
 * folder.
 *
 *     gitOpsSources(nodes, pathRules?) => GitOpsSource[]
 *     cloneFor(repo, clones, remotes?) => string | undefined
 *
 * Argo CD. An Application's paths are what chant's k8s catalog says they are:
 * its `pathRefs` rules (chant#5102, `applicationPathRules`) read
 * `spec.source.path` and `spec.sources[].path`, leave out a source that names
 * a chart, and refuse a path that is absolute or climbs out of the
 * repository. Only the directories are read here; the values files those
 * rules also list are not. Without the rules (an older chant), no Application
 * is read.
 *
 * Flux. chant's catalog has no rule for Flux, so this module reads it: a
 * `kustomize.toolkit.fluxcd.io` Kustomization's `spec.path` (the repository's
 * root when it is absent) in the repository its `spec.sourceRef` names, a
 * `source.toolkit.fluxcd.io` GitRepository in the Kustomization's namespace
 * unless the reference names another, whose `spec.url` is the repository.
 * A source of another kind (an OCIRepository, a Bucket) is not a repository
 * and is not read.
 *
 * Clones. Nothing is fetched. A repository is read only from a directory the
 * caller names: `--git <dir>` holds every repository whose URL is that
 * directory (a `file://` URL or a path) or one of its git remotes, and
 * `--git <url>=<dir>` holds that one URL. URLs are compared without their
 * scheme, user, `.git` suffix and trailing slash, so
 * `git@github.com:org/repo.git` and `https://github.com/org/repo` name one
 * repository. A clone's remotes are read with `git config`, which reads the
 * clone's own config and makes no request.
 */
import { execFileSync } from "node:child_process";
import { posix, resolve } from "node:path";

type Rec = Record<string, unknown>;

/** A path rule of chant's catalog, as far as this module calls it. */
export interface GitPathRule {
  from: string;
  path: string;
  read(node: { id: string; kind: string; attrs: Rec }): Array<{ value: string; repo: string; type: "dir" | "file" }>;
}

/** A node of a cluster read, as far as this module reads it. */
export interface SourceNode {
  id: string;
  kind: string;
  attrs?: Rec;
  listedType?: string;
}

export interface GitOpsSource {
  /** The id of the Application or Kustomization card. */
  app: string;
  /** What the card is: `Application` (Argo CD) or `Kustomization` (Flux). */
  via: "Application" | "Kustomization";
  /** The object's own name. */
  name: string;
  /** The repository URL, as the object names it. */
  repo: string;
  /** The directory in the repository, from its root, `/`-separated; empty for the root. */
  path: string;
  /** The revision the object tracks, when it names one. */
  revision?: string;
}

/** A directory that holds a repository: for every URL it answers to, or for one URL. */
export interface GitClone {
  dir: string;
  url?: string;
}

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const meta = (n: SourceNode): Rec => (isRec(n.attrs?.metadata) ? (n.attrs!.metadata as Rec) : {});

/** A listed type's group and kind: `kustomize.toolkit.fluxcd.io/v1/Kustomization` is that group's Kustomization. */
function groupKind(listedType: string | undefined): { group: string; kind: string } | undefined {
  const parts = (listedType ?? "").split("/");
  if (parts.length !== 3) return undefined;
  return { group: parts[0]!, kind: parts[2]! };
}

/** A path from the repository's root, or undefined when it is absolute or climbs out of it. */
function repoPath(path: string): string | undefined {
  if (path.startsWith("/")) return undefined;
  const norm = posix.normalize(path).replace(/\/+$/, "");
  if (norm === ".." || norm.startsWith("../")) return undefined;
  return norm === "." ? "" : norm;
}

/** The revision an Argo CD source tracks. */
function argoRevision(attrs: Rec | undefined, repo: string, path: string): string | undefined {
  const spec = isRec(attrs?.spec) ? (attrs!.spec as Rec) : {};
  const sources = [...(isRec(spec.source) ? [spec.source] : []), ...(Array.isArray(spec.sources) ? spec.sources.filter(isRec) : [])] as Rec[];
  const s = sources.find((x) => x.repoURL === repo && repoPath(String(x.path ?? "")) === path);
  return str(s?.targetRevision);
}

/** The revision a Flux GitRepository tracks: its commit, tag, semver range, branch or ref name. */
function fluxRevision(repo: SourceNode): string | undefined {
  const ref = isRec((repo.attrs?.spec as Rec | undefined)?.ref) ? ((repo.attrs!.spec as Rec).ref as Rec) : {};
  return str(ref.commit) ?? str(ref.tag) ?? str(ref.semver) ?? str(ref.branch) ?? str(ref.name);
}

/** The GitOps sources the nodes name. `pathRules` is chant's k8s catalog's `pathRefs`. */
export function gitOpsSources(nodes: readonly SourceNode[], pathRules: readonly GitPathRule[] = []): GitOpsSource[] {
  const out: GitOpsSource[] = [];
  const seen = new Set<string>();
  const push = (s: GitOpsSource) => {
    const key = `${s.app}\0${s.repo}\0${s.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  for (const n of nodes) {
    const gk = groupKind(n.listedType);
    const name = str(meta(n).name) ?? n.id;
    // Argo CD: chant's path rules for the node's kind, directories only.
    for (const rule of pathRules) {
      if (rule.from !== n.kind) continue;
      for (const ref of rule.read({ id: n.id, kind: n.kind, attrs: n.attrs ?? {} })) {
        if (ref.type !== "dir") continue;
        const revision = argoRevision(n.attrs, ref.repo, ref.value);
        push({ app: n.id, via: "Application", name, repo: ref.repo, path: ref.value, ...(revision ? { revision } : {}) });
      }
    }
    // Flux: a Kustomization and the GitRepository it names.
    if (gk?.group === "kustomize.toolkit.fluxcd.io" && gk.kind === "Kustomization") {
      const spec = isRec(n.attrs?.spec) ? (n.attrs!.spec as Rec) : {};
      const ref = isRec(spec.sourceRef) ? spec.sourceRef : {};
      if (ref.kind !== "GitRepository" || !str(ref.name)) continue;
      const ns = str(ref.namespace) ?? str(meta(n).namespace);
      const repo = nodes.find((r) => {
        const rgk = groupKind(r.listedType);
        return rgk?.group === "source.toolkit.fluxcd.io" && rgk.kind === "GitRepository" && meta(r).name === ref.name && str(meta(r).namespace) === ns;
      });
      const url = str((repo?.attrs?.spec as Rec | undefined)?.url);
      const path = repoPath(str(spec.path) ?? "");
      if (!repo || !url || path === undefined) continue;
      const revision = fluxRevision(repo);
      push({ app: n.id, via: "Kustomization", name, repo: url, path, ...(revision ? { revision } : {}) });
    }
  }
  return out;
}

/** A repository URL with its scheme, user, `.git` suffix and trailing slash left out; a local path as `file:<absolute path>`. */
export function repoKey(url: string): string {
  const u = url.trim();
  if (u.startsWith("file://")) return `file:${resolve(decodeURIComponent(u.slice("file://".length))).replace(/\/+$/, "")}`;
  if (u.startsWith("/")) return `file:${resolve(u).replace(/\/+$/, "")}`;
  const tidy = (host: string, path: string) => `${host.toLowerCase()}/${path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "")}`;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(u);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return tidy(scp[1]!, scp[2]!);
  try {
    const parsed = new URL(u);
    return tidy(parsed.hostname, decodeURIComponent(parsed.pathname));
  } catch {
    return u.replace(/\/+$/, "").replace(/\.git$/, "");
  }
}

/** The URLs a local clone's remotes name, from its own config. No request is made. */
export function gitRemotes(dir: string): string[] {
  try {
    const out = execFileSync("git", ["-C", dir, "config", "--get-regexp", "^remote\\..*\\.url$"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/)[1])
      .filter((x): x is string => !!x);
  } catch {
    return [];
  }
}

/** The directory of the clone that holds `repo`, or undefined when none the caller named does. */
export function cloneFor(repo: string, clones: readonly GitClone[], remotes: (dir: string) => string[] = gitRemotes): string | undefined {
  const key = repoKey(repo);
  for (const c of clones) if (c.url !== undefined && repoKey(c.url) === key) return resolve(c.dir);
  for (const c of clones) {
    if (c.url !== undefined) continue;
    const dir = resolve(c.dir);
    if (repoKey(dir) === key || remotes(dir).some((r) => repoKey(r) === key)) return dir;
  }
  return undefined;
}
