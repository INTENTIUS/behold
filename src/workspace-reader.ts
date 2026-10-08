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
import { runChantRaw } from "./chant.ts";

/** The read contract version behold reads (chant's `reference/workspace-read-contract`). */
export const WORKSPACE_CONTRACT = 1;
/** The first chant that writes contract 1. An older one has no `workspace` command at all. */
export const WORKSPACE_CHANT_FLOOR = "0.81.0";

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
  run(argv: string[]): Promise<TransportRun>;
}

export type WorkspaceDocument = Record<string, unknown>;

export interface WorkspaceReader {
  /** Run one contract command with `args`, and return the document chant printed, unchanged. */
  read(command: WorkspaceReadCommand, args: string[]): Promise<WorkspaceDocument>;
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
    error: `chant workspace ${command} wrote a document with ${said}; behold reads contract ${WORKSPACE_CONTRACT}.`,
    code: "workspace-contract",
    remedy:
      doc.contract === undefined
        ? `Upgrade the workspace's chant to ${WORKSPACE_CHANT_FLOOR} or newer.`
        : "Upgrade behold: this chant writes a newer workspace contract than it knows.",
  };
}

/** The refusal code for a command: `workspace-ls`, `workspace-graph`, `workspace-intent`. */
const codeFor = (command: WorkspaceReadCommand): string => (command === "graph --intent" ? "workspace-intent" : `workspace-${command}`);

/** The reader over `chant`. One read is one chant call. */
export function workspaceReader(chant: ChantTransport): WorkspaceReader {
  return {
    async read(command, args) {
      const argv = readArgv(command, args);
      const shown = `chant ${argv.join(" ")}`;
      const run = await chant.run(argv);
      const code = codeFor(command);
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
    async run(argv) {
      const r = await runChantRaw(argv, root, env);
      return { status: r.code, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

/** The reader for a workspace root: {@link workspaceReader} over {@link rootTransport}. */
export function rootReader(root: string, env?: Record<string, string>): WorkspaceReader {
  return workspaceReader(rootTransport(root, env));
}
