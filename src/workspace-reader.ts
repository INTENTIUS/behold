/**
 * #468: the one module behold reads a declared workspace through.
 *
 * ws-052 says a reader reads only through chant's read contract: it runs a
 * contract command, takes the document chant prints, and computes no join
 * chant can do itself. Every workspace read behold makes (`ls`, `graph
 * --member`, `status`, `graph --intent`) goes through {@link workspaceReader},
 * and chant's reader conformance suite (`@intentius/chant/workspace/
 * conformance`) runs against this same function in behold's tests
 * (src/workspace-reader-conformance.test.ts). The suite checks that each read
 * is exactly one chant call of the contract command, that the document handed
 * back is the one chant printed, that it validates against chant's schema, and
 * that no file in the workspace changed.
 *
 * The reader is built over a {@link ChantTransport}, so it never learns the
 * workspace's path: the transport is its only way in. In behold that
 * transport is {@link rootTransport}, which runs the workspace root's own chant
 * through `runChantRaw`, so a read takes a slot in behold's read budget and is
 * cancelled when the page that asked for it goes away (src/read-scheduler.ts).
 *
 * A document written to any contract but {@link WORKSPACE_CONTRACT} is
 * refused whole, as {@link WorkspaceReadError}: within a version chant only
 * adds fields, and a new version can change what one means.
 */
import { resolve } from "node:path";
import { runChantRaw } from "./chant.ts";
import { healthProblems, HEALTH_SCHEMA, type HealthDocument } from "./runtime-health.ts";

/** The read contract version behold reads (chant's `reference/workspace-read-contract`). */
export const WORKSPACE_CONTRACT = 1;
/** The first chant that writes contract 1 (see src/chant-floors.ts). */
import { WORKSPACE_CHANT_FLOOR } from "./chant-floors.ts";
export { WORKSPACE_CHANT_FLOOR };

/** The read-contract commands behold reads, named the way chant's conformance suite names them. */
export const BEHOLD_READS = ["ls", "graph", "status", "graph --intent"] as const;
export type WorkspaceReadCommand = (typeof BEHOLD_READS)[number];

/**
 * The flag each command takes to print its document. `graph` always prints
 * JSON (the contract's table says "always"), so it gets none, as it had none
 * before this module.
 */
export const JSON_FLAGS: Record<WorkspaceReadCommand, readonly string[]> = {
  ls: ["--json"],
  graph: [],
  status: ["--json"],
  "graph --intent": ["--json"],
};

/** Why behold will not use a workspace document, in the #193 refusal shape. */
export interface WorkspaceRefusal {
  error: string;
  code: string;
  remedy: string;
}

/** A read behold refuses: chant printed nothing, something that isn't a JSON object, or another contract. */
export class WorkspaceReadError extends Error {
  constructor(readonly refusal: WorkspaceRefusal) {
    super(`${refusal.error} ${refusal.remedy}`);
  }
}

/** One chant run, as the conformance suite's transport reports it. */
export interface TransportRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** How the reader reaches chant. Shaped like the conformance suite's `ChantTransport`. */
export interface ChantTransport {
  /** `dir`, when given, is a member's directory relative to the workspace root, for a read chant answers per member. */
  run(argv: string[], options?: { dir?: string }): Promise<TransportRun>;
}

export type WorkspaceDocument = Record<string, unknown>;

/**
 * #680: the trunk lane's reads. They are read contract 1 documents too
 * (ci-list.schema.json, releases.schema.json), but chant names them outside
 * `chant workspace`: `ci list` runs at the workspace root, `release list` in
 * one member's directory. chant's reader conformance suite does not list them,
 * so they are not in {@link BEHOLD_READS}; each one still checks its floor in
 * src/chant-floors.ts before it is sent.
 */
export const TRUNK_READS = ["ci list", "release list"] as const;
export type TrunkReadCommand = (typeof TRUNK_READS)[number];

/**
 * #681: the stored change-set read, `chant change-set show <digest> --member
 * <name> --json` (change-set-show.schema.json, chant#4022), run at the
 * workspace root. Like the trunk reads it is a contract 1 document outside
 * `chant workspace` that chant's conformance suite does not list, and its
 * floor is in src/chant-floors.ts.
 */
export const CHANGE_SET_READ = "change-set show";

/**
 * #472: the open decision points, `chant workspace points --open --json`
 * (points.schema.json, ws-058), run at the workspace root. It is a `chant
 * workspace` command, but chant's reader conformance suite does not list it
 * (its `commands` are the read-contract table's), so it is not in
 * {@link BEHOLD_READS}; its floor is in src/chant-floors.ts. behold reads the
 * questions and never answers one: `points answer` is a person's, at a shell
 * or in the host's rail.
 */
export const POINTS_READ = "points --open";

/**
 * behold#815: chant's run index (ci-run-index.schema.json, chant#4098), the
 * document `chant ci runs --report-url <url> --json` prints. The runner keeps
 * it at `<url>/runs/index.json`, and behold reads that file from the report
 * URL rather than running a chant: the CI host's chant wrote it, not the
 * project's. It still comes through {@link ciRunIndexOf} here, refused at any
 * contract but 1, and its floor is in src/chant-floors.ts.
 */
export const CI_RUNS_READ = "ci runs";

/**
 * #825: runtime health, `chant lifecycle health <env> --json` (chant#4177),
 * run in a project's directory or a member's, since chant has no workspace
 * form of it. Its document is `chant-health/v1`, not a contract 1 document,
 * so it is checked by {@link healthProblems} instead of the contract check,
 * and its floor is in src/chant-floors.ts (`HEALTH_CHANT_FLOOR`).
 */
export const HEALTH_READ = "lifecycle health";

/** chant's words when no configured lexicon has a health read: it prints no document and exits 1. */
const NO_HEALTH_READ = /no configured lexicon has a health read|no health read in this lexicon/i;

/** The reads named outside `chant workspace`, for a refusal's wording. */
const OUTSIDE_WORKSPACE: readonly string[] = [...TRUNK_READS, CHANGE_SET_READ, CI_RUNS_READ];

export interface WorkspaceReader {
  /** Run one contract command with `args`, and return the document chant printed, unchanged. */
  read(command: WorkspaceReadCommand, args: string[]): Promise<WorkspaceDocument>;
  /** Run one trunk read (#680), in member directory `dir` when given, and return the document chant printed, unchanged. */
  readTrunk(command: TrunkReadCommand, args: string[], dir?: string): Promise<WorkspaceDocument>;
  /** #681: the change set stored under `digest` in `member`'s ledger, as chant printed it. chant exits 1 when none is stored, and still prints the document. */
  readChangeSet(digest: string, member: string): Promise<WorkspaceDocument>;
  /** #472: the workspace's open decision points and their questions, as chant printed them. */
  readPoints(): Promise<WorkspaceDocument>;
  /** #825: runtime health in `env`, in directory `dir` when given (a member's), as chant printed it once it passes {@link healthProblems}. */
  readHealth(env: string, dir?: string): Promise<HealthDocument>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The argv one read runs: `workspace <command> <args> <json flag>`. */
export function readArgv(command: WorkspaceReadCommand, args: readonly string[]): string[] {
  return ["workspace", ...command.split(" "), ...args, ...JSON_FLAGS[command]];
}

/**
 * The contract check every workspace document gets, or undefined when the
 * document is written to the contract behold reads.
 */
export function contractRefusal(doc: Record<string, unknown>, command: string): WorkspaceRefusal | undefined {
  if (doc.contract === WORKSPACE_CONTRACT) return undefined;
  const said = doc.contract === undefined ? "no contract version" : `contract ${JSON.stringify(doc.contract)}`;
  return {
    error: `chant ${OUTSIDE_WORKSPACE.includes(command) ? command : `workspace ${command}`} wrote a document with ${said}; behold reads contract ${WORKSPACE_CONTRACT}.`,
    code: "workspace-contract",
    remedy:
      doc.contract === undefined
        ? `Upgrade the workspace's chant to ${WORKSPACE_CHANT_FLOOR} or newer.`
        : "Upgrade behold: this chant writes a newer workspace contract than it knows.",
  };
}

/** The refusal code for a command: `workspace-ls`, `workspace-graph`, `workspace-intent`. */
const codeFor = (command: WorkspaceReadCommand): string => (command === "graph --intent" ? "workspace-intent" : `workspace-${command}`);

/** The argv one trunk read runs: `ci list <args> --json`, `release list <args> --json`. */
export function trunkArgv(command: TrunkReadCommand, args: readonly string[]): string[] {
  return [...command.split(" "), ...args, "--json"];
}

/** The argv the change-set read runs: `change-set show <digest> --member <member> --json`. */
export function changeSetArgv(digest: string, member: string): string[] {
  return ["change-set", "show", digest, "--member", member, "--json"];
}

/** The argv the points read runs: `workspace points --open --json`. */
export function pointsArgv(): string[] {
  return ["workspace", ...POINTS_READ.split(" "), "--json"];
}

/** The argv the health read runs: `lifecycle health <env> --json`. */
export function healthArgv(env: string): string[] {
  return [...HEALTH_READ.split(" "), env, "--json"];
}

/**
 * Check what the health read printed: a `chant-health/v1` document with the
 * fields behold reads. A project with no lexicon that reads health prints
 * nothing and says so, which is `health-none`, not a failure. A document
 * printed alongside a nonzero exit means chant could not build the project.
 */
export function healthDocumentOf(run: TransportRun, shown: string): HealthDocument {
  const remedy = `Run \`${shown}\` to see what it says.`;
  const said = run.stderr.trim().split("\n").slice(-3).join(" ");
  if (!run.stdout.trim()) {
    if (NO_HEALTH_READ.test(run.stderr)) throw new WorkspaceReadError({ error: `${shown} found no lexicon with a health read.`, code: "health-none", remedy: "aws, azure and gcp have one (chant#4177)." });
    throw new WorkspaceReadError({ error: `${shown} printed nothing (exit ${run.status ?? "killed"})${said ? `: ${said}` : ""}`, code: "lifecycle-health", remedy });
  }
  let doc: unknown;
  try {
    doc = JSON.parse(run.stdout);
  } catch {
    throw new WorkspaceReadError({ error: `${shown} printed something that is not JSON.`, code: "lifecycle-health", remedy });
  }
  if (isRecord(doc) && doc.schema !== HEALTH_SCHEMA) {
    throw new WorkspaceReadError({
      error: `${shown} wrote ${doc.schema === undefined ? "a document with no schema" : `a ${JSON.stringify(doc.schema)} document`}; behold reads ${HEALTH_SCHEMA}.`,
      code: "health-schema",
      remedy: doc.schema === undefined ? "Upgrade the project's chant." : "Upgrade behold: this chant writes a health document it does not know.",
    });
  }
  const problems = healthProblems(doc);
  if (problems.length) {
    const more = problems.length > 3 ? ` (and ${problems.length - 3} more)` : "";
    throw new WorkspaceReadError({ error: `${shown} wrote a health document behold cannot read: ${problems.slice(0, 3).join("; ")}${more}.`, code: "health-schema", remedy });
  }
  if (run.status !== 0) throw new WorkspaceReadError({ error: `${shown} could not build the project (exit ${run.status ?? "killed"})${said ? `: ${said}` : ""}`, code: "lifecycle-health", remedy });
  return doc as HealthDocument;
}

/** Check what one run printed: a JSON object written to the contract behold reads. */
function documentOf(run: TransportRun, shown: string, code: string, command: string): WorkspaceDocument {
  if (!run.stdout.trim()) {
    const said = run.stderr.trim().split("\n").slice(-3).join(" ");
    throw new WorkspaceReadError({ error: `${shown} printed nothing (exit ${run.status ?? "killed"})${said ? `: ${said}` : ""}`, code, remedy: `Run \`${shown}\` in the workspace root to see what it says.` });
  }
  let doc: unknown;
  try {
    doc = JSON.parse(run.stdout);
  } catch {
    throw new WorkspaceReadError({ error: `${shown} printed something that is not JSON.`, code, remedy: `Run \`${shown}\` in the workspace root to see what it says.` });
  }
  if (!isRecord(doc)) throw new WorkspaceReadError({ error: `${shown} printed JSON that is not an object.`, code, remedy: `Run \`${shown}\` in the workspace root.` });
  const refused = contractRefusal(doc, command);
  if (refused) throw new WorkspaceReadError(refused);
  return doc;
}

/** behold#815: the run index's text, read from `where`, as a contract 1 document, or a {@link WorkspaceReadError}. */
export function ciRunIndexOf(text: string, where: string): WorkspaceDocument {
  const remedy = "`chant ci runs --report-url <url> --json` prints the index as chant reads it.";
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new WorkspaceReadError({ error: `${where} is not JSON.`, code: "ci-runs", remedy });
  }
  if (!isRecord(doc)) throw new WorkspaceReadError({ error: `${where} is JSON that is not an object.`, code: "ci-runs", remedy });
  const refused = contractRefusal(doc, CI_RUNS_READ);
  if (refused) throw new WorkspaceReadError(refused);
  return doc;
}

/** The reader over `chant`. One read is one chant call. */
export function workspaceReader(chant: ChantTransport): WorkspaceReader {
  return {
    async read(command, args) {
      const argv = readArgv(command, args);
      return documentOf(await chant.run(argv), `chant ${argv.join(" ")}`, codeFor(command), command);
    },
    async readTrunk(command, args, dir) {
      const argv = trunkArgv(command, args);
      const run = await chant.run(argv, dir !== undefined ? { dir } : undefined);
      return documentOf(run, `chant ${argv.join(" ")}${dir !== undefined ? ` (in ${dir})` : ""}`, command.replace(" ", "-"), command);
    },
    async readChangeSet(digest, member) {
      const argv = changeSetArgv(digest, member);
      return documentOf(await chant.run(argv), `chant ${argv.join(" ")}`, "change-set-show", CHANGE_SET_READ);
    },
    async readPoints() {
      const argv = pointsArgv();
      return documentOf(await chant.run(argv), `chant ${argv.join(" ")}`, "workspace-points", POINTS_READ);
    },
    async readHealth(env, dir) {
      const argv = healthArgv(env);
      const run = await chant.run(argv, dir !== undefined ? { dir } : undefined);
      return healthDocumentOf(run, `chant ${argv.join(" ")}${dir !== undefined ? ` (in ${dir})` : ""}`);
    },
  };
}

/**
 * The transport behold reads a workspace over: the root's own chant, run from
 * the root (ws-021), through `runChantRaw`. `env` merges over the process
 * environment for this one run, for a lens (src/chant.ts `envOverridesFor`).
 */
export function rootTransport(root: string, env?: Record<string, string>): ChantTransport {
  return {
    async run(argv, options) {
      const r = await runChantRaw(argv, options?.dir !== undefined ? resolve(root, options.dir) : root, env);
      return { status: r.code, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

/** The reader for a workspace root: {@link workspaceReader} over {@link rootTransport}. */
export function rootReader(root: string, env?: Record<string, string>): WorkspaceReader {
  return workspaceReader(rootTransport(root, env));
}
