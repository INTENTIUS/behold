/**
 * The registry of chant version floors (#691).
 *
 * behold shells each project's own chant, so a read can be asked of a chant
 * that predates it. Every such read has one floor here: the first chant
 * release that answers it. The convention:
 *
 *  - One constant per read, named after the read (`WHY_CHANT_FLOOR`), set to
 *    the chant release that adds the read, and defined in this file.
 *  - One entry in {@link CHANT_FLOORS} naming the read in words a person
 *    recognises, the floor, and the chant issue or release that adds it.
 *  - The code that makes the read checks the project's chant with
 *    {@link floorRefusal} (or `meetsFloor`) before spawning anything, and a
 *    pane that needs the read shows that refusal while the rest of behold
 *    works. A read is never sent to a chant that would reject it.
 *  - `behold doctor` lists every entry with the project's chant version, so
 *    a new entry shows up there without further work.
 *
 * New reads go through the read contract (src/workspace-reader.ts), never
 * through chant's library. Pure: imports only src/floor.ts, so any module may
 * import it.
 */
import { meetsFloor } from "./floor.ts";

/** The first chant whose `graph` takes `--traffic` (chant#2377). An older one
 * rejects an unknown flag outright (chant#1127), so the flag is never sent
 * hopefully. */
export const TRAFFIC_FLOOR = "0.75.0";
/** The chant that ships `graph --live --namespace <ns>` (chant#1629). Below
 * this the flag is not merely ignored: chant#1127 made an unrecognised `--`
 * flag a hard error, so a member on an older chant is left unjoined rather
 * than sent an invocation its own CLI will refuse, which would turn today's
 * "pending, with the note" into "unobserved", a strictly worse picture. */
export const NAMESPACE_JOIN_FLOOR = "0.44.5";
/** The first chant that writes contract 1. An older one has no `workspace` command at all. */
export const WORKSPACE_CHANT_FLOOR = "0.81.0";
/** The first chant whose intent document carries `why` (INTENTIUS/chant#3312). */
export const WHY_CHANT_FLOOR = "0.102.0";
/** The chant that ships `chant operator log` (chant#2029). */
export const OPERATOR_LOG_FLOOR = "0.53.1";
/** The chant that first answers `chant carve status` (chant#2038). */
export const CARVE_STATUS_FLOOR = "0.54.0";
/** The first chant that answers `chant ci list --json`, each commit with its
 * work items (INTENTIUS/chant#4021, INTENTIUS/chant#4029). The trunk lane (#680). */
export const CI_LIST_CHANT_FLOOR = "0.124.28";
/** The first chant that answers `chant release list --json`, each release with
 * the environments that run it (INTENTIUS/chant#4026). The trunk lane (#680). */
export const RELEASE_LIST_CHANT_FLOOR = "0.124.28";
/** The first chant whose `workspace status` carries each member's
 * `promotionOrder` (INTENTIUS/chant#4030), and each gate's `gitSha`, `runId`
 * and `changeSet` (INTENTIUS/chant#4020, INTENTIUS/chant#4022). The trunk lane (#680). */
export const PROMOTION_ORDER_CHANT_FLOOR = "0.124.28";
/** The first chant that answers `chant change-set show <digest> --json`, the
 * change set a gate binds with each entry's graph node (INTENTIUS/chant#4022),
 * and a release gate's change set with its release and environment
 * (INTENTIUS/chant#4045). The change-set overlay (#681). */
export const CHANGE_SET_SHOW_CHANT_FLOOR = "0.124.28";
/** The first chant that streams a run's events (contract 1): `--events-json`
 * on `chant run`, `run --components`, promote, rollback, redeploy, fan-out and
 * pr-plan/pr-apply (INTENTIUS/chant#4019, INTENTIUS/chant#4041), and `chant run
 * events <run> --json --follow` (INTENTIUS/chant#4042). Below it behold starts
 * runs with the older `--progress-json` and says it is in degraded mode, and
 * reads no run it did not start (#679). */
export const RUN_EVENTS_CHANT_FLOOR = "0.124.28";
/** The first chant that says which releases are revoked and which release a
 * deploy was made from: `revoked` on each `release list` release, on a status
 * release item (with its rollback line) and on a superseded release gate
 * (INTENTIUS/chant#4033), and `releaseDigest` and `releaseLabel` on a status
 * release item (INTENTIUS/chant#4043). The trunk lane's release column (#692).
 * Below it the column is drawn from `release list` alone, with no revoked
 * mark, and says so; the lane itself still needs only 0.124.28. */
export const RELEASE_COLUMN_CHANT_FLOOR = "0.124.29";
/** The first chant whose `workspace status` lists each member's feature flags
 * as `featureFlags`, with their values per environment, owner, work item and
 * the stale-flag lint's verdict (INTENTIUS/chant#4024). The Flags tab and the
 * flag marks on the graph (#683). Below it the graph draws no flag marks and
 * the tab says which chant adds them. */
export const FEATURE_FLAGS_CHANT_FLOOR = "0.124.29";
/** The first chant whose intent document carries `trace`, the why chain
 * (INTENTIUS/chant#4023): each commit's work item, ci tag, release, the gate
 * resolutions that let the release through and its deploys per environment.
 * The why pane's chain (#682). Below it the pane shows the decisions, runs and
 * commits it always did, and says the chain needs this chant. */
export const WHY_TRACE_CHANT_FLOOR = "0.124.29";
/** The first chant whose `workspace status` gives an environment `mixed` when
 * it runs components from different releases, or a promote, rollback or
 * redeploy left a component failed or gated: each component's release and
 * state, the redeploy lines and the rollback line (INTENTIUS/chant#4035,
 * INTENTIUS/chant#4072). The trunk lane's mixed environments (#731). Below it
 * the lane is drawn as before, with no environment marked mixed. */
export const MIXED_ENVIRONMENT_CHANT_FLOOR = "0.124.29";
/** The first chant whose `workspace status` lists `overlap`: the in-flight
 * work items that changed the same files, and the entries of a waiting gate's
 * change set that two of them reach, each with its graph node
 * (INTENTIUS/chant#4025). The collision marks on the graph and the
 * Collisions tab (#684). Below it the graph draws no collision marks and the
 * tab says which chant adds them. */
export const OVERLAP_CHANT_FLOOR = "0.124.29";
/** The first chant where a gate can ask a declared decision point: `workspace
 * status` names the open question a gate waits on as its `answer`, and the
 * `approve` line is the `points answer` one (INTENTIUS/chant#3170). behold reads
 * `chant workspace points --open --json` from it and draws each open question
 * beside its gate (#472). Below it the gate strip draws no points and says
 * which chant adds them. */
export const DECISION_POINTS_CHANT_FLOOR = "0.107.0";
/** The first chant whose runner keeps a run index at its report URL,
 * `<url>/runs/index.json` (ci-run-index/v1, INTENTIUS/chant#4098,
 * INTENTIUS/chant#4114), which `chant ci runs --json` prints. The kiosk's runs
 * pane under `serve --ci-report-url` (#815). The index names the chant that
 * wrote it, and one written by an older chant is refused. */
export const CI_RUN_INDEX_CHANT_FLOOR = "0.124.31";
/** The first chant whose `workspace ls --json` carries the declaration's CI
 * report URL as `ci.reportUrl`, s3:// or file://, present only when declared
 * (INTENTIUS/chant#4160). The runs pane reads chant's run index there when
 * `serve` has no `--ci-report-url` (#818); below it, or with none declared,
 * the pane reads the forge's runs as before. */
export const CI_REPORT_URL_CHANT_FLOOR = "0.124.32";
/** The first chant whose `ci run plan|apply` takes `--local` (INTENTIUS/chant#4161,
 * chant PR #4163): the job runs on this machine with no push, no commit status
 * and nothing under a report URL, its record says `runOrigin: {forge: "local"}`
 * and its events `runtime: "local"`. "Run this job locally" (#685). Below it
 * the button is not offered, and says which chant adds it. */
export const CI_RUN_LOCAL_CHANT_FLOOR = "0.124.32";
/** The first chant that answers `chant lifecycle health <env> --json`, a
 * chant-health/v1 document: per declared resource with a health read (a
 * Route 53 health check, an ECS service, a Container App, a Cloud Run
 * service) a state of healthy, unhealthy or unknown, kept apart from the ones
 * it could not read (INTENTIUS/chant#4177, chant PR #4188). Health and
 * rotation on the graph (#825). Below it the graph draws no health marks. */
export const HEALTH_CHANT_FLOOR = "0.124.33";
/** The first chant whose `search` reads the entities a lexicon contributes
 * from build roots, as `graph` does: a Terraform folder's `terraform.roots`
 * in behold's generated scratch config (INTENTIUS/chant#4365, found by #911).
 * Below it `chant search` answers `(no matches)` there for every query, so a
 * question asked of a bare Terraform folder (#908) has no rows to draw. */
export const SEARCH_TERRAFORM_ROOTS_CHANT_FLOOR = "0.124.46";

export interface ChantFloor {
  /** The read, in words: `the why of a member or a card`. */
  read: string;
  /** The floor constant's value: the first chant release that adds the read. */
  floor: string;
  /** What adds it in chant, for the person reading doctor. */
  adds: string;
  /** Set when the pane works below the floor with less, rather than refusing: what it shows then. */
  degraded?: string;
}

/** Every read behold makes of chant that an older chant cannot answer. Add
 * one entry per new read. */
export const CHANT_FLOORS: readonly ChantFloor[] = [
  { read: "workspace read contract", floor: WORKSPACE_CHANT_FLOOR, adds: "chant workspace (contract 1)" },
  { read: "why", floor: WHY_CHANT_FLOOR, adds: "graph --intent writes a why (chant#3312)" },
  { read: "carve status", floor: CARVE_STATUS_FLOOR, adds: "chant carve status (chant#2038)" },
  { read: "operator log", floor: OPERATOR_LOG_FLOOR, adds: "chant operator log (chant#2029)" },
  { read: "graph traffic", floor: TRAFFIC_FLOOR, adds: "graph --traffic (chant#2377)" },
  { read: "namespace join", floor: NAMESPACE_JOIN_FLOOR, adds: "graph --live --namespace (chant#1629)" },
  { read: "trunk commits", floor: CI_LIST_CHANT_FLOOR, adds: "chant ci list --json (chant#4021, chant#4029)" },
  { read: "release list", floor: RELEASE_LIST_CHANT_FLOOR, adds: "chant release list --json (chant#4026)" },
  { read: "promotion order", floor: PROMOTION_ORDER_CHANT_FLOOR, adds: "workspace status promotionOrder (chant#4030)" },
  { read: "change set", floor: CHANGE_SET_SHOW_CHANT_FLOOR, adds: "chant change-set show --json (chant#4022, chant#4045)" },
  { read: "run events", floor: RUN_EVENTS_CHANT_FLOOR, adds: "run --events-json and chant run events (chant#4019, chant#4041, chant#4042)" },
  { read: "release column", floor: RELEASE_COLUMN_CHANT_FLOOR, adds: "revoked releases, and the release a deploy was made from (chant#4033, chant#4043)", degraded: "the Trunk tab draws its releases from chant release list alone, with no revoked mark" },
  { read: "feature flags", floor: FEATURE_FLAGS_CHANT_FLOOR, adds: "workspace status featureFlags (chant#4024)", degraded: "the graph draws no flag marks, and the Flags tab says which chant adds them" },
  { read: "why chain", floor: WHY_TRACE_CHANT_FLOOR, adds: "graph --intent writes a trace, the why chain (chant#4023)", degraded: "the why pane shows decisions, runs and commits without the chain from work item to release" },
  { read: "mixed environment", floor: MIXED_ENVIRONMENT_CHANT_FLOOR, adds: "workspace status mixed, with redeploy and rollback lines (chant#4035, chant#4072)", degraded: "the Trunk tab marks no environment mixed" },
  { read: "work overlap", floor: OVERLAP_CHANT_FLOOR, adds: "workspace status overlap (chant#4025)", degraded: "the graph draws no collision marks, and the Collisions tab says which chant adds them" },
  { read: "CI run index", floor: CI_RUN_INDEX_CHANT_FLOOR, adds: "chant ci run --report-url keeps runs/index.json, read by chant ci runs (chant#4098, chant#4114)" },
  { read: "declared CI report URL", floor: CI_REPORT_URL_CHANT_FLOOR, adds: "workspace ls ci.reportUrl, the declaration's report URL (chant#4160)", degraded: "the runs pane reads chant's run index only when serve is given --ci-report-url" },
  { read: "local CI run", floor: CI_RUN_LOCAL_CHANT_FLOOR, adds: "chant ci run --local (chant#4161)" },
  { read: "runtime health", floor: HEALTH_CHANT_FLOOR, adds: "chant lifecycle health --json, a chant-health/v1 document (chant#4177)", degraded: "the graph draws no health marks and no record out of rotation" },
  { read: "search over a Terraform folder", floor: SEARCH_TERRAFORM_ROOTS_CHANT_FLOOR, adds: "chant search reads terraform.roots, as graph does (chant#4365)" },
  { read: "decision points", floor: DECISION_POINTS_CHANT_FLOOR, adds: "a gate that asks a decision point, read with chant workspace points --open (chant#3170)", degraded: "the gate strip draws no open decision points, and says which chant adds them" },
];

/** One read's floor against one chant version. An unknown version meets it
 * (an unknown version is not evidence of an old one). */
export function floorMet(f: ChantFloor, version: string | undefined): boolean {
  return meetsFloor(version, f.floor);
}

/** The refusal a pane shows when the chant it would ask is older than the read's floor. */
export function floorRefusal(f: ChantFloor, version: string | undefined): { error: string; code: string; remedy: string } {
  return {
    error: `${f.read[0].toUpperCase()}${f.read.slice(1)} needs chant ${f.floor} or newer. This project has chant ${version ?? "(unknown version)"}.`,
    code: "chant-too-old",
    remedy: `Upgrade @intentius/chant to ${f.floor} or newer in the project.`,
  };
}

/** The registry's entry for a read, by its `read` name. Several reads can share one floor version, so the
 * lookup is by name. Throws on a read not registered, so a typo fails a test. */
export function floorFor(read: string): ChantFloor {
  const f = CHANT_FLOORS.find((x) => x.read === read);
  if (!f) throw new Error(`no chant floor for the read "${read}" in src/chant-floors.ts`);
  return f;
}
