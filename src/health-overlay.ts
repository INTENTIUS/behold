/**
 * #825: `GET /api/health?env=<env>`, runtime health and rotation for the graph.
 *
 * One `chant lifecycle health <env> --json` per chant project: the served
 * project, or each chant member of a workspace or an estate, in the member's
 * own directory with its own chant (chant has no workspace form of the read).
 * A member's ids are composed as `<member>/<id>`, as everywhere else. Each
 * read goes through the read contract (`readHealth`, src/workspace-reader.ts),
 * and a member whose chant is below `HEALTH_CHANT_FLOOR` is refused before
 * anything is spawned, with the rest read as usual.
 *
 * Rotation is derived here from each member's source graph (the cached
 * `memberIr`, so no extra spawn on a warm server) and the health just read,
 * by src/runtime-health.ts's `rotationOf`.
 *
 * The answer is cached per environment for {@link HEALTH_TTL_MS}: health is
 * runtime state and moves on its own, unlike the source. `?fresh=1` reads
 * again, and "Re-check live" (`POST /api/refresh`) drops the cache.
 */
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import { healthCounts, nodeHealthOf, rotationOf, type HealthCounts, type NodeHealth, type Rotation, type RotationGraph } from "./runtime-health.ts";
import { WorkspaceReadError, type WorkspaceReader, type WorkspaceRefusal } from "./workspace-reader.ts";

/** The floor registry's name for this read. */
export const HEALTH_READ_NAME = "runtime health";

/** How long one environment's answer is reused. */
export const HEALTH_TTL_MS = 30_000;

/** One chant project to read: `name` is the member name ids compose under, undefined for a lone project. */
export interface HealthMember {
  name?: string;
  dir: string;
}

/** What one member's read came to, for the page's legend and an agent. */
export interface HealthMemberRead {
  member: string | null;
  chant: string | null;
  observedAt?: string;
  /** chant's own counts, as it printed them. */
  summary?: Record<string, number>;
  /** No lexicon of this member reads health: not a failure, nothing to draw. */
  none?: true;
  refusal?: WorkspaceRefusal;
}

export interface HealthAnswer {
  env: string;
  nodes: Record<string, NodeHealth>;
  rotation: Record<string, Rotation>;
  members: HealthMemberRead[];
  counts: HealthCounts;
  /** When behold read it. Each node carries chant's own `observedAt`. */
  readAt: string;
  /** Set when no member could be read because every chant is below the floor. */
  refusal?: WorkspaceRefusal;
  degraded?: string;
}

export interface HealthDeps {
  /** The project's chant version, for the floor check. */
  chantVersion(dir: string): string | undefined;
  /** The reader for one member, over its own chant in its own directory. */
  reader(dir: string): WorkspaceReader;
  /** One member's source graph, for rotation. A failure leaves that member's records without a rotation. */
  graph(dir: string): Promise<RotationGraph>;
  now?: () => Date;
}

/** Read health for every member in `env` and derive rotation. Never throws for a member's failure: it is listed with its refusal. */
export async function readHealthOverlay(members: HealthMember[], env: string, deps: HealthDeps): Promise<HealthAnswer> {
  const floor = floorFor(HEALTH_READ_NAME);
  const reads = await Promise.all(
    members.map(async (m) => {
      const chant = deps.chantVersion(m.dir) ?? null;
      const base = { member: m.name ?? null, chant };
      if (!floorMet(floor, chant ?? undefined)) return { m, read: { ...base, refusal: floorRefusal(floor, chant ?? undefined) } as HealthMemberRead };
      try {
        const doc = await deps.reader(m.dir).readHealth(env);
        return { m, doc, read: { ...base, observedAt: doc.observedAt, ...(doc.summary ? { summary: doc.summary } : {}) } as HealthMemberRead };
      } catch (e) {
        if (!(e instanceof WorkspaceReadError)) return { m, read: { ...base, refusal: { error: `The health read stopped: ${(e as Error).message}.`, code: "lifecycle-health", remedy: "BEHOLD_READ_TIMEOUT_MS raises the read deadline; /api/doctor shows what else is reading." } } as HealthMemberRead };
        if (e.refusal.code === "health-none") return { m, read: { ...base, none: true } as HealthMemberRead };
        return { m, read: { ...base, refusal: e.refusal } as HealthMemberRead };
      }
    }),
  );
  const nodes: Record<string, NodeHealth> = {};
  for (const r of reads) if (r.doc) Object.assign(nodes, nodeHealthOf(r.doc, r.m.name));
  const rotation: Record<string, Rotation> = {};
  await Promise.all(
    reads
      .filter((r) => r.doc)
      .map(async (r) => {
        const graph = await deps.graph(r.m.dir).catch(() => undefined);
        if (graph) Object.assign(rotation, rotationOf(graph, nodes, r.m.name));
      }),
  );
  const answer: HealthAnswer = {
    env,
    nodes,
    rotation,
    members: reads.map((r) => r.read),
    counts: healthCounts(nodes, rotation),
    readAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  const tooOld = reads.filter((r) => r.read.refusal?.code === "chant-too-old");
  if (reads.length > 0 && tooOld.length === reads.length) {
    answer.refusal = tooOld[0].read.refusal;
    answer.degraded = floor.degraded;
  }
  return answer;
}

/** The per-environment cache the route keeps. */
const cache = new Map<string, { at: number; answer: HealthAnswer }>();

/** The cached answer for `env`, when it is younger than the TTL. */
export function cachedHealth(key: string, now = Date.now()): HealthAnswer | undefined {
  const hit = cache.get(key);
  return hit && now - hit.at < HEALTH_TTL_MS ? hit.answer : undefined;
}

export function rememberHealth(key: string, answer: HealthAnswer, now = Date.now()): void {
  cache.set(key, { at: now, answer });
}

/** Drop every cached answer: "Re-check live", or a host's notice that the workspace changed. */
export function invalidateHealth(): void {
  cache.clear();
}
