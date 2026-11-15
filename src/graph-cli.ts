/**
 * behold#1058: `behold graph [dir]`, and the `behold-graph` bin of
 * `@intentius/behold-graph`, which run this same function. It reads a
 * directory into behold's graph (src/graph-view.ts) and prints one output
 * format (src/graph-formats.ts) to stdout or to a file. No server starts and
 * no browser opens, and nothing is written but the `-o` file.
 *
 * With `--context` or `--kubeconfig` it draws a cluster instead of a
 * directory (behold#1083, src/read-cluster.ts): chant's read-only lister over
 * the kubeconfig's context, nothing written, no project needed.
 *
 * Exit codes: 0 printed, 1 the directory or cluster could not be read (chant
 * refused the workspace declaration, the cluster did not answer), 2 a usage
 * error or a credential rule refusing the read (an exec plugin kubeconfig
 * without --allow-exec-plugin).
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cutChanged, CHANGED_NODE_BUDGET } from "./graph-changed.ts";
import { cutDocument, type CutDirection } from "./graph-cut.ts";
import type { GraphDocument } from "./graph-document.ts";
import { documentOptions } from "./graph-document-context.ts";
import { emptyDocument, gitRoot, parseRange, readAtRevision, resolveRange, RevisionError } from "./graph-revisions.ts";
import { GRAPH_FORMATS, PENDING_FORMATS, graphFormat } from "./graph-formats.ts";
import { FORGES, isForge, type Forge } from "./mermaid-budgets.ts";
import { isSvgTheme, SVG_THEMES, FlatLayoutTooLarge, type SvgTheme } from "./graph-svg.ts";
import { clusterView, graphView, type GraphView } from "./graph-view.ts";
import { ReadGraphError } from "./read-graph.ts";
import { ClusterReadRefusal, readCluster } from "./read-cluster.ts";
import { documentScrubber } from "./graph-document-context.ts";

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
  return `Usage: ${prog} [dir] [${flags}] [--theme light|dark] [-o <file>] [--detail 0..3] [--source] [--every-card]
       ${prog} [dir] --changed <base>..<head> [--depth n] [--budget n]
       ${prog} --context <name> [--kubeconfig <file>] [--namespace <ns,...>] [--types <t,...>] [--allow-exec-plugin]
       ${prog} [dir] --around <id>[,<id>...] [--depth n] [--up | --down]

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
  --theme <name> With --svg: ${SVG_THEMES.join(" or ")} (default dark).
  -o <file>      Write to <file> instead of stdout.
  --detail <n>   0 to 3, as the zoom levels read (default 2, resources;
                 3 adds attributes, and a Kubernetes object's spec).
  --source       Keep each card's source text (attrs.source), which is left
                 out by default: a Terraform root's whole file rides on every
                 card from it.
  --every-card   Draw every card: no stacking of alike cards in a box.
  --changed <base>..<head>
                 Cut to what changed between two commits, plus the cards
                 within --depth hops of it (default 1), each marked added,
                 removed, changed or neighbour. Both are read from git
                 archive into a temporary directory: the checkout is not
                 touched, and a shallow clone works once the two commits are
                 fetched. <base>...<head> starts from their merge base. The
                 read is at --detail 3 unless you give another, since below
                 it a card holds no attributes to compare. Past --budget
                 cards (default ${CHANGED_NODE_BUDGET}) the neighbours fold into a count per box, then
                 the cut becomes a table of counts per box.
  --around <id>[,<id>...]
                 Cut to the cards (or boxes) named and what is within --depth
                 hops of them (default 1). --up follows what they depend on,
                 --down what depends on them; the default is both. Exit 1
                 when an id is not in the graph.
  --context <name>
                 Draw the cluster that kubeconfig context points at, with no
                 project: chant's read-only lister runs API discovery and a
                 LIST per kind, and nothing is written (no index store, no
                 file). Cards are boxed by namespace; cluster-scoped objects
                 sit in a box named cluster. Not with a dir or --changed.
                 A Secret's data is masked by the
                 lister, and so is any field whose name matches /secret/i.
  --kubeconfig <file>
                 The kubeconfig to read (default: the first path in
                 KUBECONFIG, then ~/.kube/config). Alone it reads that file's
                 current-context.
  --namespace <ns,...>
                 With --context: list only these namespaces. Add cluster to
                 list cluster-scoped objects too. Default: all of them.
  --types <t,...>
                 With --context: list only these types, as the lister names
                 them (apps/v1/Deployment, v1/Service).
  --allow-exec-plugin
                 With --context: a kubeconfig user that authenticates through
                 an exec plugin (the GKE, EKS and AKS tools write these) is
                 refused by default, because behold would run the command the
                 file names. This runs it once and reads with the credential
                 it prints. An auth-provider user is always refused.
  --depth <n>    Hops for --changed and --around.
  --budget <n>   Cards a --changed cut may hold before it folds.
`;
}

interface Parsed {
  dir: string;
  format: string;
  out?: string;
  detail?: number;
  forge?: Forge;
  theme?: SvgTheme;
  source: boolean;
  alike: boolean;
  changed?: string;
  around?: string[];
  depth?: number;
  budget?: number;
  direction?: CutDirection;
  context?: string;
  kubeconfig?: string;
  namespaces?: string[];
  types?: string[];
  allowExec: boolean;
}

function parse(argv: readonly string[]): Parsed | { error: string } | { help: true } {
  let dir: string | undefined;
  let format: string | undefined;
  let out: string | undefined;
  let detail: number | undefined;
  let forge: Forge | undefined;
  let theme: SvgTheme | undefined;
  let source = false;
  let alike = true;
  let changed: string | undefined;
  let around: string[] | undefined;
  let depth: number | undefined;
  let budget: number | undefined;
  let direction: CutDirection | undefined;
  let context: string | undefined;
  let kubeconfig: string | undefined;
  let namespaces: string[] | undefined;
  let types: string[] | undefined;
  let allowExec = false;
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
    } else if (a === "--theme") {
      const v = argv[++i];
      if (v === undefined || !isSvgTheme(v)) return { error: `--theme takes ${SVG_THEMES.join(" or ")}` };
      theme = v;
    } else if (a === "--context" || a === "--kubeconfig") {
      const v = argv[++i];
      if (!v) return { error: `${a} needs a ${a === "--context" ? "context name" : "file"}` };
      if (a === "--context") context = v;
      else kubeconfig = v;
    } else if (a === "--namespace" || a === "--namespaces" || a === "--types") {
      const v = argv[++i]?.split(",").map((x) => x.trim()).filter(Boolean);
      if (!v?.length) return { error: `${a} needs one or more names, comma separated` };
      if (a === "--types") types = v;
      else namespaces = v;
    } else if (a === "--allow-exec-plugin") {
      allowExec = true;
    } else if (a === "--source") {
      source = true;
    } else if (a === "--every-card") {
      alike = false;
    } else if (a === "--changed") {
      changed = argv[++i];
      if (!changed) return { error: "--changed needs a range: <base>..<head>" };
    } else if (a === "--around") {
      const v = argv[++i];
      around = v?.split(",").map((x) => x.trim()).filter(Boolean);
      if (!around?.length) return { error: "--around needs one or more ids, comma separated" };
    } else if (a === "--depth" || a === "--budget") {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v) || (a === "--budget" && Number(v) < 1)) return { error: `${a} takes a whole number${a === "--budget" ? " of 1 or more" : ""}` };
      if (a === "--depth") depth = Number(v);
      else budget = Number(v);
    } else if (a === "--up" || a === "--down") {
      const d = a.slice(2) as CutDirection;
      if (direction && direction !== d) return { error: "--up and --down name two directions; give one, or neither for both" };
      direction = d;
    } else if (a.startsWith("-")) {
      return { error: `unknown option ${a}` };
    } else if (dir === undefined) {
      dir = a;
    } else {
      return { error: `one directory only (got ${dir} and ${a})` };
    }
  }
  const cluster = context !== undefined || kubeconfig !== undefined;
  if (cluster && dir !== undefined) return { error: `a directory and a cluster are two reads; give ${dir} or --context, not both` };
  if (cluster && changed) return { error: "--changed reads two commits of a directory; it does not go with --context" };
  if (!cluster && (namespaces || types || allowExec)) return { error: "--namespace, --types and --allow-exec-plugin go with --context" };
  if (forge && format !== "mermaid") return { error: "--forge goes with --mermaid" };
  if (changed && around) return { error: "--changed and --around are two cuts; give one" };
  if ((depth !== undefined || budget !== undefined || direction) && !changed && !around) return { error: "--depth, --budget, --up and --down go with --changed or --around" };
  if (changed && direction) return { error: "--up and --down go with --around: a changed cut keeps neighbours both ways" };
  if (around && budget !== undefined) return { error: "--budget goes with --changed" };
  if ((changed || around) && format === "ir") return { error: "--ir is always the whole view; a cut is over the --json document" };
  if (theme && format !== "svg") return { error: "--theme goes with --svg" };
  return {
    dir: dir ?? ".",
    format: format ?? "json",
    ...(out ? { out } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(forge ? { forge } : {}),
    ...(theme ? { theme } : {}),
    source,
    alike,
    allowExec,
    ...(context ? { context } : {}),
    ...(kubeconfig ? { kubeconfig } : {}),
    ...(namespaces ? { namespaces } : {}),
    ...(types ? { types } : {}),
    ...(changed ? { changed } : {}),
    ...(around ? { around } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(direction ? { direction } : {}),
  };
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
  const cluster = parsed.context !== undefined || parsed.kubeconfig !== undefined;
  const dir = resolve(parsed.dir);
  if (!cluster && (!existsSync(dir) || !statSync(dir).isDirectory())) {
    stderr(`${io.prog ?? "behold graph"}: ${parsed.dir} is not a directory\n`);
    return 2;
  }
  const prog = io.prog ?? "behold graph";
  let view: GraphView;
  let document: ReturnType<typeof documentOptions>;
  let cut: ((doc: GraphDocument) => GraphDocument) | undefined;
  let keptCards: number | undefined;
  try {
    if (parsed.changed) {
      const range = parseRange(parsed.changed);
      if ("error" in range) {
        stderr(`${prog}: ${range.error}\n`);
        return 2;
      }
      const root = gitRoot(dir);
      const { base, head } = resolveRange(root, range);
      // Below detail 3 a card holds no attributes, so an edited attribute would not show.
      const detail = parsed.detail ?? 3;
      const opts = { alike: false, detail, behold: io.version, source: parsed.source };
      const headRead = await readAtRevision(root, dir, head, opts);
      if (!headRead) {
        stderr(`${prog}: ${parsed.dir} does not exist at ${range.head} (${head.slice(0, 10)})\n`);
        return 1;
      }
      const baseRead = await readAtRevision(root, dir, base, opts);
      const before = baseRead?.document ?? emptyDocument(headRead.document, base);
      view = headRead.view;
      document = headRead.options;
      const names = { base: range.mergeBase ? `${range.base}...` : range.base, head: range.head };
      cut = (after) => {
        const doc = cutChanged(before, after, {
          base: names.base,
          head: names.head,
          ...(parsed.depth !== undefined ? { depth: parsed.depth } : {}),
          ...(parsed.budget !== undefined ? { budget: parsed.budget } : {}),
        });
        keptCards = doc.nodes.length;
        if (detail < 3) doc.notes.push({ kind: "changed-detail", text: `read at --detail ${detail}: a card holds no attributes there, so only added and removed cards show; use --detail 3 to see an edited attribute` });
        return doc;
      };
    } else if (cluster) {
      const read = await readCluster({
        ...(parsed.context ? { context: parsed.context } : {}),
        ...(parsed.kubeconfig ? { kubeconfig: parsed.kubeconfig } : {}),
        ...(parsed.namespaces ? { namespaces: parsed.namespaces } : {}),
        ...(parsed.types ? { types: parsed.types } : {}),
        allowExecPlugin: parsed.allowExec,
        version: io.version,
      });
      view = await clusterView(read, { alike: parsed.alike, ...(parsed.detail !== undefined ? { detail: parsed.detail } : {}) });
      // No directory was read: the origin is the working directory only so the document has one, and the cluster is named in the note.
      document = { generator: { behold: io.version }, origin: { dir: "." }, members: {}, scrub: documentScrubber(resolve("."), []) };
    } else {
      view = await graphView(dir, { alike: parsed.alike, ...(parsed.detail !== undefined ? { detail: parsed.detail } : {}) });
      document = documentOptions({ projectDir: dir, ...(view.read.workspace ? { workspace: view.read.workspace } : {}), behold: io.version });
    }
    if (parsed.around) {
      const ids = parsed.around;
      cut = (doc) => {
        const r = cutDocument(doc, ids, { ...(parsed.depth !== undefined ? { depth: parsed.depth } : {}), ...(parsed.direction ? { direction: parsed.direction } : {}) });
        if (!r.ok) throw new CutRefused(r.error);
        keptCards = r.document.nodes.length;
        return r.document;
      };
    }
  } catch (err) {
    if (err instanceof ReadGraphError) {
      stderr(`${err.refusal.error}\n${err.refusal.remedy}\n`);
      return 1;
    }
    if (err instanceof ClusterReadRefusal) {
      stderr(`${prog}: ${err.message}\n${err.remedy}\n`);
      return err.code === "exec-plugin" || err.code === "auth-provider" ? 2 : 1;
    }
    if (err instanceof RevisionError) {
      stderr(`${prog}: ${err.message}\n${err.remedy ? `${err.remedy}\n` : ""}`);
      return 1;
    }
    throw err;
  }
  let text: string | Uint8Array;
  try {
    text = format.emit({ view, document, source: parsed.source, ...(parsed.forge ? { forge: parsed.forge } : {}), ...(parsed.theme ? { theme: parsed.theme } : {}), ...(cut ? { cut } : {}) });
  } catch (err) {
    if (err instanceof CutRefused || err instanceof FlatLayoutTooLarge) {
      stderr(`${prog}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  const cards = keptCards ?? view.ir.nodes.length;
  if (parsed.out) {
    writeFileSync(resolve(parsed.out), text);
    stderr(`wrote ${parsed.out} (${cards} ${cards === 1 ? "card" : "cards"})\n`);
  } else {
    stdout(text);
  }
  return 0;
}

/** `--around` named an id the graph does not hold. */
class CutRefused extends Error {}
