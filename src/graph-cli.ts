/**
 * behold#1058: `behold graph [dir]`, and the `behold-graph` bin of
 * `@intentius/behold-graph`, which run this same function. It reads a
 * directory into behold's graph (src/graph-view.ts) and prints one output
 * format (src/graph-formats.ts) to stdout or to a file. No server starts and
 * no browser opens, and nothing is written but the `-o` file.
 *
 * Exit codes: 0 printed, 1 the directory could not be read (chant refused
 * the workspace declaration, say), 2 a usage error.
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { documentOptions } from "./graph-document-context.ts";
import { GRAPH_FORMATS, PENDING_FORMATS, graphFormat } from "./graph-formats.ts";
import { FORGES, isForge, type Forge } from "./mermaid-budgets.ts";
import { graphView } from "./graph-view.ts";
import { ReadGraphError } from "./read-graph.ts";

export interface GraphCliIO {
  /** behold's version, for the document's `generator`. */
  version: string;
  /** The command as the person typed it, for the usage text. */
  prog?: string;
  stdout?: (text: string | Uint8Array) => void;
  stderr?: (text: string) => void;
}

export function graphUsage(prog = "behold graph"): string {
  const flags = [...GRAPH_FORMATS.map((f) => f.name), ...Object.keys(PENDING_FORMATS)].map((n) => `--${n}`).join(" | ");
  return `Usage: ${prog} [dir] [${flags}] [-o <file>] [--detail 0..3] [--source] [--every-card]

Read a directory into behold's graph and print it. Starts no server.

  dir            A folder of .tf files, a chant workspace root, a choudoufu
                 estate or a chant project. Default: the current directory.
${GRAPH_FORMATS.map((f) => `  --${f.name.padEnd(13)}${f.summary}`).join("\n")}
${Object.keys(PENDING_FORMATS)
  .map((n) => `  --${n.padEnd(13)}not in this version yet`)
  .join("\n")}
  --forge <name> With --mermaid: fit that forge's character budget, one of
                 ${FORGES.join(", ")} (default github). Over budget, neighbours go
                 first, then whole boxes, and a line says how many cards are
                 not shown.
  -o <file>      Write to <file> instead of stdout.
  --detail <n>   0 to 3, as the zoom levels read (default 2, resources;
                 3 adds attributes, and a Kubernetes object's spec).
  --source       Keep each card's source text (attrs.source), which is left
                 out by default: a Terraform root's whole file rides on every
                 card from it.
  --every-card   Draw every card: no stacking of alike cards in a box.
`;
}

interface Parsed {
  dir: string;
  format: string;
  out?: string;
  detail?: number;
  forge?: Forge;
  source: boolean;
  alike: boolean;
}

function parse(argv: readonly string[]): Parsed | { error: string } | { help: true } {
  let dir: string | undefined;
  let format: string | undefined;
  let out: string | undefined;
  let detail: number | undefined;
  let forge: Forge | undefined;
  let source = false;
  let alike = true;
  const formats = new Set([...GRAPH_FORMATS.map((f) => f.name), ...Object.keys(PENDING_FORMATS)]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") return { help: true };
    if (a.startsWith("--") && formats.has(a.slice(2))) {
      if (format && format !== a.slice(2)) return { error: `--${format} and ${a} name two formats; give one` };
      format = a.slice(2);
    } else if (a === "-o" || a === "--out") {
      out = argv[++i];
      if (!out) return { error: `${a} needs a file` };
    } else if (a === "--detail") {
      const v = argv[++i];
      if (v === undefined || !/^[0-3]$/.test(v)) return { error: "--detail takes 0, 1, 2 or 3" };
      detail = Number(v);
    } else if (a === "--forge") {
      const v = argv[++i];
      if (v === undefined || !isForge(v)) return { error: `--forge takes ${FORGES.join(", ")}` };
      forge = v;
    } else if (a === "--source") {
      source = true;
    } else if (a === "--every-card") {
      alike = false;
    } else if (a.startsWith("-")) {
      return { error: `unknown option ${a}` };
    } else if (dir === undefined) {
      dir = a;
    } else {
      return { error: `one directory only (got ${dir} and ${a})` };
    }
  }
  if (forge && format !== "mermaid") return { error: "--forge goes with --mermaid" };
  return { dir: dir ?? ".", format: format ?? "json", ...(out ? { out } : {}), ...(detail !== undefined ? { detail } : {}), ...(forge ? { forge } : {}), source, alike };
}

/** Run `behold graph` with `argv` (the arguments after `graph`). Answers the exit code. */
export async function runGraph(argv: readonly string[], io: GraphCliIO): Promise<number> {
  const stdout = io.stdout ?? ((t) => void process.stdout.write(t));
  const stderr = io.stderr ?? ((t) => void process.stderr.write(t));
  const usage = graphUsage(io.prog);
  const parsed = parse(argv);
  if ("help" in parsed) {
    stdout(usage);
    return 0;
  }
  if ("error" in parsed) {
    stderr(`${io.prog ?? "behold graph"}: ${parsed.error}\n\n${usage}`);
    return 2;
  }
  const pending = PENDING_FORMATS[parsed.format];
  if (pending) {
    stderr(`${io.prog ?? "behold graph"}: ${pending}\n`);
    return 2;
  }
  const format = graphFormat(parsed.format)!;
  const dir = resolve(parsed.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    stderr(`${io.prog ?? "behold graph"}: ${parsed.dir} is not a directory\n`);
    return 2;
  }
  let view;
  try {
    view = await graphView(dir, { alike: parsed.alike, ...(parsed.detail !== undefined ? { detail: parsed.detail } : {}) });
  } catch (err) {
    if (err instanceof ReadGraphError) {
      stderr(`${err.refusal.error}\n${err.refusal.remedy}\n`);
      return 1;
    }
    throw err;
  }
  const document = documentOptions({ projectDir: dir, ...(view.read.workspace ? { workspace: view.read.workspace } : {}), behold: io.version });
  const text = format.emit({ view, document, source: parsed.source, ...(parsed.forge ? { forge: parsed.forge } : {}) });
  if (parsed.out) {
    writeFileSync(resolve(parsed.out), text);
    stderr(`wrote ${parsed.out} (${view.ir.nodes.length} ${view.ir.nodes.length === 1 ? "card" : "cards"})\n`);
  } else {
    stdout(text);
  }
  return 0;
}
