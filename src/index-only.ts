/**
 * behold#1026: behold only reads while it serves no project. A directory with
 * no chant project and no estate member in it (an index store, an empty
 * directory) has nothing for an action to act on, and a route that spawns
 * chant there would run against whatever the directory's parents hold. So
 * every write route refuses with 409, except the ones in INDEX_ONLY_WRITES.
 *
 * The acting set is not listed. It is every non-GET route the server mounts,
 * minus the allowlist below, so a route added later is refused here until
 * someone reads it and puts it on the list. src/index-only.test.ts walks
 * `app.routes` and POSTs to each one.
 */
import { existsSync } from "node:fs";
import { READ_METHODS } from "./terragucci-repo.ts";
import { detectProjectShape } from "./project.ts";

/** The writes an index-only serve still answers. Each writes nothing outside behold and starts no chant command. */
export const INDEX_ONLY_WRITES: readonly { method: string; pattern: RegExp; why: string }[] = [
  { method: "POST", pattern: /^\/api\/layout$/, why: "the hand layout, a per-user cache outside any project" },
  { method: "POST", pattern: /^\/api\/view$/, why: "moves the open tabs' view and writes nothing" },
  { method: "POST", pattern: /^\/api\/refresh$/, why: "drops behold's caches" },
  { method: "POST", pattern: /^\/api\/project\/open$/, why: "switches what is served, which is how an index-only serve reaches a project" },
  { method: "POST", pattern: /^\/api\/project\/reveal$/, why: "opens the served directory in the file manager" },
  { method: "POST", pattern: /^\/api\/demos\/open$/, why: "loads a bundled demo into a copy behold makes, and serves that" },
];

/** True when `dir` is a directory that holds no chant project and no estate member. Sync and read-only; a path that is not there is left to each route's own answer. */
export function servesNoProject(dir: string): boolean {
  return existsSync(dir) && detectProjectShape(dir).kind === "none";
}

/** The refusal for a write on an index-only serve, or undefined when the route may answer. */
export function indexOnlyRefusal(method: string, path: string): { error: string; code: "no-project"; remedy: string } | undefined {
  if (READ_METHODS.has(method.toUpperCase())) return undefined;
  if (INDEX_ONLY_WRITES.some((w) => w.method === method.toUpperCase() && w.pattern.test(path))) return undefined;
  return {
    error: `there is no chant project here, so behold only reads: ${method.toUpperCase()} ${path} is refused`,
    code: "no-project",
    remedy: "Serve a chant project to act on it (behold serve <dir>), or open one with POST /api/project/open.",
  };
}
