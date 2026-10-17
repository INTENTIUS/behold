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

export interface ChantFloor {
  /** The read, in words: `the why of a member or a card`. */
  read: string;
  /** The floor constant's value: the first chant release that adds the read. */
  floor: string;
  /** What adds it in chant, for the person reading doctor. */
  adds: string;
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
