/**
 * Multi-estate composition (#31, headline of M4) — the app-of-apps view. behold
 * graphs N chant projects and composes their IRs into one estate via pinhole's
 * `composeStacks`: ids namespaced per project (`<project>/<nodeId>`), a
 * `groups.byStack` entry per project, and cross-stack edges from export↔import
 * handle matching (chant #513). Composition lives in the viewer, not chant —
 * behold just points at the projects.
 *
 * `groups.byStack` becomes an actual drawn boundary box (not just an IR field)
 * via `src/server.ts`'s `/api/graph` multi-estate branch passing `{ boxes:
 * "byStack" }` to `renderGraph` (src/render.ts) — see that module's doc comment
 * for why it's an explicit opt-in there rather than auto-detected.
 *
 * Source-level composition only (each project's `graphIr` call uses whatever
 * `opts` the request carries — an `env` reaches every composed project's own
 * chant the same way). A per-project env/live overlay (e.g. loomster live,
 * a second project source-only) is possible today by choosing `opts` per
 * project; that per-project targeting isn't wired into the HTTP API yet — see
 * the M4 report for what a proper "many live instances" estate would need.
 */
import { statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve, sep } from "node:path";
import { composeStacks, shortStackNames, type GraphIR } from "@intentius/pinhole";
import { graphIr, meetsFloor, resolveChant, type GraphOptions } from "./chant.ts";
import { memberIr } from "./member-ir.ts";
import { CLUSTER_SCOPED } from "./zoom-notes.ts";

// ---------------------------------------------------------------------------
// Bounded member reads (#295). Every estate read below fans out one `chant
// graph` process per member, and each of those is a whole Node process doing
// a full TypeScript evaluation of that member's source — seconds of CPU
// each, before the live half even talks to a cluster. The fan-outs used to
// be unbounded `Promise.all`s, which on an 11-member estate meant 11 chant
// processes landing on the host at once; on the modest boxes estates
// actually get served from, that oversubscription degrades toward serial
// (~60s per /api/overlay on the #295 estate — worse than one member at a
// time, because they thrash instead of pipelining). A small pool keeps the
// host busy without drowning it.
// ---------------------------------------------------------------------------

/** How many member chant processes one estate read runs at once: the host's
 * parallelism capped at 4 (each spawn wants a core-plus for its TS eval),
 * never more lanes than members. `BEHOLD_ESTATE_CONCURRENCY` overrides the
 * cap for tuning a live estate; anything unparseable or < 1 is ignored
 * rather than honoured into a stall. Exported for testing. */
export function estateReadPool(members: number, env: Record<string, string | undefined> = process.env): number {
  const override = Number.parseInt(env.BEHOLD_ESTATE_CONCURRENCY ?? "", 10);
  const cap = Number.isInteger(override) && override >= 1 ? override : Math.min(4, availableParallelism());
  return Math.max(1, Math.min(cap, members));
}

/** `Promise.all(items.map(fn))` with at most `width` calls in flight.
 * Results land at their item's own index, so per-member attribution is
 * position-stable no matter what order the reads finish in. A rejection
 * rejects the whole map, exactly as `Promise.all` did — callers that want a
 * member's failure contained (`composeEstateOverlay`) catch inside `fn`,
 * same as before. Exported for testing. */
export async function mapPool<T, R>(
  items: readonly T[],
  width: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, () => worker()));
  return results;
}

// #307: the pool bounded the fan-out and left the latency alone — the total
// work is still one whole chant process per member per read, ~85% of which is
// spawn + chant's own module load. Every SOURCE read below therefore goes
// through `memberIr` (src/member-ir.ts), which serves a member whose source,
// chant and options are all unchanged without spawning anything; the live pass
// still spawns per member, every read, because a cluster moves with nothing on
// disk to notice. The invalidation rule lives in that module's header.

/** Each member paired with the name `composeStacks` namespaces its ids under —
 * the one fact a composed IR does not carry, and what `src/estate-edges.ts`
 * needs to join a declared `spec.path` back to the member it points at (#166).
 * One reading of `shortStackNames`, so the names here and the ids in the
 * composed IR cannot drift apart. */
export function estateMembers(projectDirs: readonly string[]): { name: string; dir: string }[] {
  const names = shortStackNames([...projectDirs]);
  return projectDirs.map((dir, i) => ({ name: names[i], dir }));
}

/** Graph each project's source and compose them into one estate IR. */
export async function composeEstate(projectDirs: string[], opts: GraphOptions = {}): Promise<GraphIR> {
  const names = shortStackNames(projectDirs); // readable per-project labels (common prefix stripped)
  const stacks = await mapPool(projectDirs, estateReadPool(projectDirs.length), async (dir, i) => ({
    name: names[i],
    ir: await memberIr(dir, opts),
  }));
  return composeStacks(stacks);
}

/** The estate-wide overlay's composition report (#189). */
export interface EstateOverlayResult {
  ir: GraphIR;
  /** How many projects were actually observed live. */
  observed: number;
  total: number;
  /** Live observe failed; the project's SOURCE graph is in `ir`, every node
   * painted `neutral` + `_unobserved` (#1089's tri-state: unobserved ≠
   * absent) rather than dropped from the picture. */
  unobserved: { name: string; reason: string }[];
  /** Even the source graph failed — the project is absent from `ir`. */
  dropped: { name: string; reason: string }[];
  /** #221: the members whose live read was scoped to a namespace the ESTATE
   * declared rather than the member itself — see `estateNamespaceScopes`.
   * Sorted by name; empty on an estate with no such binding. */
  joined: { name: string; namespace: string }[];
}

/** A short human reason from a failure. ChantCliError's message leads with
 * the full invocation line — the part after "exited N: " is chant's own
 * words, which is what a note (or an inspect pane) should carry. */
const firstLine = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/exited \d+:\s*([\s\S]*)/);
  return (m ? m[1] : msg).split("\n")[0].trim().slice(0, 160);
};

/**
 * pinhole's `composeStacks` namespaces node ids (`<stack>/<id>`) and
 * `compositeInstance`, but not `runtimeOwner` — chant#1180's first-class IR
 * field postdates composition, so it passes through the spread verbatim.
 * Left alone, a composed estate's runtime child (a Pod its Deployment created,
 * a workload Flux's Kustomization applied) points at a bare `appA` while the
 * owner it names is now `control-plane/appA`, and
 * `attachRuntimeContainment` (src/overlay.ts, #86) keys a containment box on
 * an id no node has: a box with the children inside and the owner nowhere,
 * which is precisely the shape #144 fixed one estate ago.
 *
 * So namespace it here, on the member's own IR before composition, using
 * composeStacks' own `<stack>/<id>` convention — and only when the owner is
 * one of this member's nodes, since chant resolves the owner chain within a
 * project and an unresolvable name is better left untouched than rewritten
 * into a different lie. Mutates + returns `ir`.
 */
export function namespaceRuntimeOwners(name: string, ir: GraphIR): GraphIR {
  const own = new Set(ir.nodes.map((n) => n.id));
  for (const n of ir.nodes as Array<{ runtimeOwner?: string }>) {
    if (n.runtimeOwner && own.has(n.runtimeOwner)) n.runtimeOwner = `${name}/${n.runtimeOwner}`;
  }
  return ir;
}

// ---------------------------------------------------------------------------
// The GitOps namespace join (#221) — the estate reading its app projects where
// they actually run.
//
// A GitOps estate splits one fact across two projects: the control plane
// declares `Kustomization.spec.targetNamespace`, the app project declares bare
// objects the controller stamps at apply time. Neither project alone knows
// where its workloads live, so an app project's live read fell through to the
// substrate default, found nothing, and the overlay painted weeks-old running
// infrastructure `pending` — honestly (nothing WAS in `default`) and
// uselessly. #192 shipped the note that explains it; this joins the halves so
// there is nothing to explain.
//
// The join only exists in composition: it is the one question a single project
// cannot answer and an estate can, which is the whole argument for reading N
// projects together. chant#1629's `--namespace <ns>` is the seam on the other
// side — a per-READ default, so nothing about the declared source is rewritten
// and an object naming its own namespace is untouched.
// ---------------------------------------------------------------------------

/** The chant that ships `graph --live --namespace <ns>` (chant#1629). Below
 * this the flag is not merely ignored: chant#1127 made an unrecognised `--`
 * flag a hard error, so a member on an older chant is left unjoined rather
 * than sent an invocation its own CLI will refuse — which would turn today's
 * "pending, with the note" into "unobserved", a strictly worse picture. */
export const NAMESPACE_JOIN_FLOOR = "0.44.5";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

const realIsDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Every `{ path, namespace }` a member's source declares through a Flux
 * `Kustomization` — the estate's own statement of where a directory of
 * manifests gets applied. Both halves required: a Kustomization with no
 * `targetNamespace` binds nothing, and one whose `path` chant left as an
 * unresolved AttrRef (not a string) names no directory this can match.
 *
 * Flux only, deliberately. Argo's `Application` carries the same shape
 * (`spec.source.path` + `spec.destination.namespace`) and would slot in here
 * unchanged, but the argo-estate demo's app projects declare their own
 * namespaces, so adding it now would ship a join no estate exercises. */
export function declaredNamespaceBindings(ir: GraphIR): { path: string; namespace: string }[] {
  const out: { path: string; namespace: string }[] = [];
  for (const n of ir.nodes) {
    if (n.kind !== "K8s::Flux::Kustomization") continue;
    const spec = rec(n.attrs?.spec);
    const namespace = str(spec?.targetNamespace);
    const path = str(spec?.path);
    if (namespace && path) out.push({ path, namespace });
  }
  return out;
}

/** Does this member declare k8s objects that name no namespace of their own —
 * the shape something stamps at apply time?
 *
 * Cluster-scoped kinds are ignored (nothing to stamp, so no evidence either
 * way — the same reading `namespaceMismatchNote` takes, off the same set). One
 * object naming its own namespace is enough to answer no: that project already
 * says where it lives, chant's `--namespace` would leave it alone anyway, and
 * a default nobody needs is a default that can only be wrong. */
export function awaitsNamespaceBinding(ir: GraphIR): boolean {
  const namespaced = ir.nodes.filter((n) => n.lexicon === "k8s" && !CLUSTER_SCOPED.has(n.kind ?? ""));
  if (namespaced.length === 0) return false;
  return namespaced.every((n) => !str(rec(n.attrs?.metadata)?.namespace));
}

/** A declared `spec.path` split into segments, or undefined when it is not a
 * repo-relative path this can reason about. Absolute paths and `..` escapes
 * are out: matching either would mean guessing at a repository root nobody in
 * the estate named. */
function declaredSegments(path: string): string[] | undefined {
  if (path.startsWith("/")) return undefined;
  const segs = path.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.length === 0 || segs.includes("..")) return undefined;
  return segs;
}

/**
 * How specifically a declared `spec.path` points at the member project rooted
 * at `dir` — 0 for no match, else the number of leading path segments that
 * matched, which doubles as the specificity score when several bindings claim
 * the same member.
 *
 * The rule: a Flux `spec.path` is relative to the SOURCE's root, and behold
 * knows a member by its checkout path, not by where a GitRepository would put
 * it — so the two are aligned by overlap. The declared path's leading segments
 * must equal the member directory's trailing segments (`example-flux-estate/
 * app-b` against `…/behold/example-flux-estate/app-b`), and whatever remains
 * of the declared path must then exist as a real directory under the member
 * (`manifests`). Anchoring at the member's own tail is what keeps a
 * Kustomization aimed at a PARENT directory from claiming everything beneath
 * it, and the on-disk check is what keeps a coincidental name overlap from
 * counting as a match.
 *
 * Exported for testing; `isDir` is injected for the same reason. */
export function pathAlignment(declared: string, dir: string, isDir: (p: string) => boolean = realIsDir): number {
  const want = declaredSegments(declared);
  if (!want) return 0;
  const root = resolve(dir);
  const have = root.split(sep).filter(Boolean);
  // Longest overlap first: the most specific reading of the path wins.
  for (let k = Math.min(want.length, have.length); k >= 1; k--) {
    if (!have.slice(-k).every((s, i) => s === want[i])) continue;
    if (!isDir(join(root, ...want.slice(k)))) continue;
    return k;
  }
  return 0;
}

/** One member's live read scoped by another member's declaration. */
export interface NamespaceJoin {
  /** The member being scoped, by project dir. */
  dir: string;
  namespace: string;
  /** The `spec.path` that matched, and the member dir that declared it. */
  path: string;
  declaredBy: string;
}

/**
 * Match each declared binding to the member project its path points at, for
 * members that declare no namespace of their own. Pure (given `isDir`).
 *
 * Conservative at both ends. A binding is dropped when two candidate members
 * match its path equally well, and a member is dropped when two bindings claim
 * it for DIFFERENT namespaces — an estate that says two things says nothing,
 * and no join leaves exactly today's behaviour (pending, plus #192's note)
 * rather than a confident read of the wrong namespace. A binding never scopes
 * the member that declared it: the split across projects is the premise.
 */
export function joinNamespaceBindings(
  members: readonly { dir: string; ir: GraphIR | undefined }[],
  isDir: (p: string) => boolean = realIsDir,
): NamespaceJoin[] {
  const bindings = members.flatMap((m) =>
    m.ir ? declaredNamespaceBindings(m.ir).map((b) => ({ ...b, declaredBy: m.dir })) : [],
  );
  if (bindings.length === 0) return [];
  const awaiting = members.filter((m) => m.ir && awaitsNamespaceBinding(m.ir));
  if (awaiting.length === 0) return [];

  const best = new Map<string, { score: number; join: NamespaceJoin } | "ambiguous">();
  for (const b of bindings) {
    let winner: { dir: string; score: number } | undefined;
    let tied = false;
    for (const m of awaiting) {
      if (m.dir === b.declaredBy) continue;
      const score = pathAlignment(b.path, m.dir, isDir);
      if (score === 0) continue;
      if (!winner || score > winner.score) {
        winner = { dir: m.dir, score };
        tied = false;
      } else if (score === winner.score) {
        tied = true;
      }
    }
    if (!winner || tied) continue;
    const prev = best.get(winner.dir);
    if (prev === "ambiguous") continue;
    const join: NamespaceJoin = { dir: winner.dir, namespace: b.namespace, path: b.path, declaredBy: b.declaredBy };
    if (!prev) best.set(winner.dir, { score: winner.score, join });
    else if (prev.join.namespace !== b.namespace) best.set(winner.dir, "ambiguous");
    else if (winner.score > prev.score) best.set(winner.dir, { score: winner.score, join });
  }
  return [...best.values()].filter((v): v is { score: number; join: NamespaceJoin } => v !== "ambiguous").map((v) => v.join);
}

/**
 * The namespace each member's live read should be scoped to, keyed by project
 * dir — the join above, resolved against the estate's real source.
 *
 * This costs one extra chant invocation per member, source-only. It has to:
 * the namespace is an INPUT to the live read, so it cannot be recovered from
 * the read's own output, and the declaration lives in a project other than the
 * one being scoped. Detail 3 because `spec` is the attributes tier (the same
 * reason the runtime tier forces it — see server.ts's estate branch), `env`
 * kept because a targetNamespace can be env-conditioned source and the
 * question is what the estate declares FOR THIS ENVIRONMENT, `live`/`overlay`
 * dropped because reading the cluster to decide where to read the cluster is
 * circular. Every failure is silent and means no join: an estate that can't be
 * graphed for its bindings gets exactly the picture it got before.
 */
export async function estateNamespaceScopes(
  projectDirs: readonly string[],
  opts: GraphOptions,
  isDir: (p: string) => boolean = realIsDir,
): Promise<Map<string, string>> {
  // A one-project "estate" has no other member to carry the binding.
  if (projectDirs.length < 2) return new Map();
  const { live: _live, overlay: _overlay, namespace: _namespace, ...src } = opts;
  // Cached per member (#307): source-only by construction (the `live`/`overlay`
  // strip above is the whole point of this pass), so on an estate whose source
  // has not moved this costs no processes at all — it is half of
  // `composeEstateOverlay`'s spawns, and the half that never needed the cluster.
  const irs = await mapPool(projectDirs, estateReadPool(projectDirs.length), (dir) =>
    memberIr(dir, { ...src, detail: 3 }).catch(() => undefined),
  );
  const scopes = new Map<string, string>();
  for (const j of joinNamespaceBindings(projectDirs.map((dir, i) => ({ dir, ir: irs[i] })), isDir)) {
    // chant#1629's flag or nothing — see NAMESPACE_JOIN_FLOOR.
    if (!meetsFloor(resolveChant(j.dir).version, NAMESPACE_JOIN_FLOOR)) continue;
    scopes.set(j.dir, j.namespace);
  }
  return scopes;
}

/** The composed nodes that do NOT belong to a joined member. `composeStacks`
 * namespaces every id `<member>/<id>`, so a member's slice of the composed IR
 * is exactly that prefix — which lets #192's namespace-mismatch note keep
 * speaking for the members the join did not reach while going quiet about the
 * ones it did, where "the live read looked in default" is simply no longer
 * true. */
export function withoutJoinedMembers<T extends { id: string }>(
  nodes: readonly T[],
  joined: readonly { name: string }[],
): T[] {
  if (joined.length === 0) return [...nodes];
  return nodes.filter((n) => !joined.some((j) => n.id.startsWith(`${j.name}/`)));
}

/**
 * The estate-wide live overlay (#189): overlay each project and compose the
 * results, rather than composing sources and overlaying only the primary —
 * "behold your whole estate, coloured by drift" was 1/N projects true before
 * this. One `env` name reaches every composed project's own chant (the same
 * threading `composeEstate` does; per-project env mapping is a future
 * decision the issue records). Reads run concurrently — through the bounded
 * pool above (#295), so a big estate pipelines instead of thrashing — with
 * per-project failure isolation: one unreachable cluster degrades that
 * project to its source graph painted `unobserved`, never blanks the estate;
 * a project whose source can't even be graphed is dropped and reported.
 *
 * `classify` is the per-project post-pass (the caller's reclassifyOverlay) —
 * a parameter so this module stays composition-only.
 *
 * #221: each member's read is scoped first by `estateNamespaceScopes` — the
 * one thing composition can tell a member that the member cannot tell itself.
 */
export async function composeEstateOverlay(
  projectDirs: string[],
  opts: GraphOptions,
  classify: (ir: GraphIR) => GraphIR,
): Promise<EstateOverlayResult> {
  const names = shortStackNames(projectDirs);
  const unobserved: { name: string; reason: string }[] = [];
  const dropped: { name: string; reason: string }[] = [];
  const joined: { name: string; namespace: string }[] = [];
  const stacks: ({ name: string; ir: GraphIR } | undefined)[] = new Array(projectDirs.length);
  // #221: where the estate itself says a member's objects run. Resolved before
  // the live pass because it is an argument TO that pass.
  const scopes = await estateNamespaceScopes(projectDirs, opts);
  await mapPool(projectDirs, estateReadPool(projectDirs.length), async (dir, i) => {
    const name = names[i];
    const namespace = scopes.get(dir);
    try {
      const live = { ...opts, live: true, overlay: true, ...(namespace ? { namespace } : {}) };
      stacks[i] = { name, ir: namespaceRuntimeOwners(name, classify(await graphIr(dir, live))) };
      // Reported only for a read that actually happened — an unobserved
      // member was not read anywhere, joined namespace or not.
      if (namespace) joined.push({ name, namespace });
    } catch (err) {
      const reason = firstLine(err);
      try {
        // Source fallback WITHOUT env/live: the declared shape, honestly
        // tagged as not-looked-at rather than absent.
        const { env: _env, live: _live, overlay: _overlay, ...srcOpts } = opts;
        const src = await memberIr(dir, srcOpts);
        for (const n of src.nodes) n.attrs = { ...n.attrs, _status: "neutral", _unobserved: reason };
        stacks[i] = { name, ir: src };
        unobserved.push({ name, reason });
      } catch (err2) {
        dropped.push({ name, reason: firstLine(err2) });
      }
    }
  });
  const present = stacks.filter((s): s is { name: string; ir: GraphIR } => !!s);
  return {
    ir: composeStacks(present),
    observed: present.length - unobserved.length,
    total: projectDirs.length,
    unobserved,
    dropped,
    // Concurrent reads finish in whatever order the clusters answer; the note
    // this feeds should read the same twice.
    joined: joined.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
