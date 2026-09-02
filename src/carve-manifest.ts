/**
 * The carve state manifest reader (#230 M3) — what makes the strangler-fig
 * picture survive a restart.
 *
 * chant ≥ 0.52.2 (chant#998, chant PR #1575) persists a manifest beside the
 * emitted source: `carve emit` writes `<slug>.carve.json` into its `--output`
 * dir carrying the target address, the boundary report and an `emit` record;
 * `carve bridge` adds a `bridge` record; `carve apply` adds an `apply` record
 * with the ownership marker. Plain JSON on disk, one file per carved address —
 * the durable record of which resources have graduated from Terraform to
 * chant, which is exactly the progression source #230 M3 asked for.
 *
 * behold reads it and never writes it. The manifest is chant's file: it is
 * written by the three carve verbs and by nothing else, and a reader that
 * touched it would be inventing state the tool it describes did not record.
 *
 * The three sections are cumulative, so their presence IS the stage:
 *
 *   emit only            -> `emitted`  — typed chant source exists; the
 *                                       surviving Terraform still reads the
 *                                       resource directly.
 *   emit + bridge        -> `bridged`  — the survivor patch is proposed; the
 *                                       resource has NOT changed hands.
 *   emit + bridge + apply-> `applied`  — graduation is recorded: the ownership
 *                                       marker is resolved and chant owns it.
 *
 * Only `applied` is graduation. `emitted` and `bridged` are work in progress
 * and are rendered as such — a card that read "carved" the moment source was
 * emitted would claim an ownership transfer that has not happened, which is
 * the one class of lie every behold view is built to avoid.
 *
 * `carve apply` is a HUMAN step here, always — see {@link APPLY_IS_HUMAN}.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GraphIR, IRNode } from "@intentius/chant";

/** chant's own suffix (`CARVE_MANIFEST_SUFFIX` in its manifest.ts). */
export const CARVE_MANIFEST_SUFFIX = ".carve.json";

/**
 * THE APPLY BOUNDARY, stated once and referenced from every place the
 * temptation arises (src/carve-actions.ts, carveRoutes in src/server.ts,
 * web/carve-steps.js).
 *
 * `carve apply` resolves the ownership marker that makes chant the owner of a
 * live resource. behold renders its state from the manifest and echoes the
 * command a person could retype — the same posture the Handoff step already
 * takes with `terraform state rm` — and offers no endpoint and no button for
 * it. That is not an oversight to be fixed later: behold triggers delegated
 * work, it does not decide when an estate changes hands.
 */
export const APPLY_IS_HUMAN =
  "`chant carve apply` graduates ownership — it resolves the marker that makes chant the owner of a live " +
  "resource. behold shows what the manifest records and echoes the command; it has no apply endpoint and no " +
  "apply button, by design. Read the graduation plan, then run it yourself.";

/** One carve's persisted state, as chant writes it. Every field past `version`
 * and `target` is optional here even where chant's own type requires it — a
 * reader should never harden a contract it does not own more than it must. */
export interface CarveManifest {
  /** 1: every recorded path absolute. 2 (chant ≥ 0.54.0, chant#2039): every
   * recorded path relative to the manifest's own directory. Same sections
   * either way; `carveStateOf` resolves the one path the views join on. */
  version: 1 | 2;
  /** Terraform address of the carved resource, e.g. `aws_s3_bucket.assets`. */
  target: string;
  tfType?: string;
  /** The Terraform estate the carve came from. */
  from?: string;
  statePath?: string;
  /** chant's boundary report for this carve, persisted at emit time. */
  boundary?: unknown;
  emit?: {
    source?: "tfstate" | "live" | string;
    files?: string[];
    /** Deferred outbound inputs declared as build parameters (chant#998). */
    params?: Record<string, { tfAttr?: string; survivor?: string; attrs?: string[]; default?: unknown }>;
    at?: string;
  };
  bridge?: {
    written?: string[];
    appliedInPlace?: boolean;
    patch?: string;
    /** Carved addresses whose own `.tf` block the rewrites remove. */
    excised?: string[];
    at?: string;
  };
  apply?: {
    marker?: { stack?: string; env?: string };
    ownershipTags?: Record<string, string>;
    stampedFiles?: string[];
    at?: string;
  };
}

/** How far along a carve is. Cumulative — see the module comment. */
export type CarveStage = "emitted" | "bridged" | "applied";

/** How a stage paints. `accent` is the in-flight tone: an existing pinhole
 * status token, distinct from the three band tones (`good`/`warn`/`neutral`)
 * the ranking already spends, so a partly-carved card cannot be mistaken for a
 * band verdict. Both partial stages share it and are told apart by their WORD
 * ({@link carveWordFor}), which is on the card: a second tone would have to
 * borrow a token that already means something else in this picture, and tone
 * alone was never allowed to carry a state here anyway. */
export type CarveTone = "good" | "accent";

/** One carved address, flattened for rendering. */
export interface CarveState {
  target: string;
  tfType?: string;
  stage: CarveStage;
  /** True only at `applied`: chant owns it, so it draws in the chant box. */
  graduated: boolean;
  /** When the LAST recorded step ran (ISO 8601), when chant stamped one. */
  at?: string;
  /** Emitted chant source files, as the manifest records them — absolute in a
   * V1 manifest, relative to the manifest's own directory since chant 0.54.0
   * (chant#2039). */
  files: string[];
  /** The same files, resolved absolute against the manifest's directory — the
   * side of the chant#2040 join a graph node's `sourceLoc.file` is compared to. */
  sourceFiles: string[];
  /** Terraform blocks the bridge patch would remove. */
  excised: string[];
  /** Deferred deploy-time inputs the emit recorded, `<param> ← <survivor>`. */
  deferredInputs: string[];
  /** The ownership marker `carve apply` resolved. Present iff `applied`. */
  ownership?: { stack?: string; env?: string; tags?: Record<string, string> };
  /** The Terraform estate the carve came from, as the manifest recorded it. */
  from?: string;
  /** The `--output` dir this manifest sits in — where the later verbs compose. */
  outDir: string;
  /** Where the manifest was read from. */
  path: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * A parsed manifest, or null when the value is not a v1 carve manifest.
 *
 * Same shallow discipline as `parseCarveReport`: the fields the renderer reads
 * are checked, the rest is passed through. A version this reader does not know
 * is a refusal rather than a best-effort read — a future major would mean
 * something else by these sections, and half-reading it would put a wrong
 * stage on a card. Versions 1 and 2 differ only in how paths are recorded
 * (chant#2039), which `carveStateOf` normalizes — the same pair chant's own
 * `readCarveManifest` accepts. (Refusing 2 here is what made behold 0.16.0
 * read every fresh 0.54 carve as nothing carved; the live walkthrough caught it.)
 */
export function parseCarveManifest(value: unknown): CarveManifest | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1 && value.version !== 2) return null;
  if (typeof value.target !== "string" || !value.target) return null;
  return value as unknown as CarveManifest;
}

/** Read + parse one manifest file. `readFile` is injected so the reader stays
 * pure for tests; anything unreadable or unparseable is null, never a throw —
 * a stray file in a carveout is not a reason to fail a graph request. */
export function readCarveManifest(path: string, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): CarveManifest | null {
  let text: string;
  try {
    text = readFile(path);
  } catch {
    return null;
  }
  try {
    return parseCarveManifest(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The stage a manifest's recorded sections add up to. */
export function carveStageOf(m: CarveManifest): CarveStage {
  if (m.apply) return "applied";
  if (m.bridge) return "bridged";
  return "emitted";
}

/** The stage's word, as it reads on a card and in the panel. The word is the
 * state's carrier; the tone only reinforces it. */
export function carveWordFor(stage: CarveStage): string {
  switch (stage) {
    case "applied":
      return "carved → chant";
    case "bridged":
      return "bridged — apply is yours";
    default:
      return "emitted — not bridged";
  }
}

/** The stage's tone. See {@link CarveTone} for why both partial stages share
 * `accent`. */
export function carveToneFor(stage: CarveStage): CarveTone {
  return stage === "applied" ? "good" : "accent";
}

/** A one-line reading of a stage, for the panel and the inspect pane. */
export function carveStageNote(state: CarveState): string {
  switch (state.stage) {
    case "applied":
      return (
        `graduated — \`carve apply\` recorded the ownership marker` +
        (state.ownership?.stack ? ` (stack ${state.ownership.stack}${state.ownership.env ? `, env ${state.ownership.env}` : ""})` : "") +
        ". chant owns it."
      );
    case "bridged":
      return "emitted and bridged — the survivor patch is proposed. Terraform still owns the resource until `carve apply`.";
    default:
      return "emitted — typed chant source exists, and the surviving Terraform still reads the resource directly. `carve bridge` is next.";
  }
}

/** Flatten a manifest into the shape the views render. */
export function carveStateOf(m: CarveManifest, path: string): CarveState {
  const stage = carveStageOf(m);
  const deferred = Object.entries(m.emit?.params ?? {}).map(([name, p]) => `${name} ← ${p?.survivor ?? "a survivor"}`);
  return {
    target: m.target,
    ...(m.tfType ? { tfType: m.tfType } : {}),
    stage,
    graduated: stage === "applied",
    // The last stamped step wins — that is the age of the state, not the age
    // of the carve.
    ...(m.apply?.at || m.bridge?.at || m.emit?.at ? { at: m.apply?.at ?? m.bridge?.at ?? m.emit?.at } : {}),
    files: strings(m.emit?.files),
    sourceFiles: strings(m.emit?.files).map((f) => (isAbsolute(f) ? f : resolve(dirname(path), f))),
    excised: strings(m.bridge?.excised),
    deferredInputs: deferred,
    ...(m.apply
      ? {
          ownership: {
            ...(m.apply.marker?.stack ? { stack: m.apply.marker.stack } : {}),
            ...(m.apply.marker?.env ? { env: m.apply.marker.env } : {}),
            ...(m.apply.ownershipTags ? { tags: m.apply.ownershipTags } : {}),
          },
        }
      : {}),
    ...(m.from ? { from: m.from } : {}),
    outDir: dirname(path),
    path,
  };
}

/** The filesystem calls discovery makes, injectable for tests. */
export interface CarveManifestIo {
  readdir: (dir: string) => string[];
  isDirectory: (p: string) => boolean;
  readFile: (p: string) => string;
}

export const nodeCarveIo: CarveManifestIo = {
  readdir: (dir) => readdirSync(dir),
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  readFile: (p) => readFileSync(p, "utf8"),
};

/** How deep discovery walks under a scanned PROJECT directory.
 *
 * chant writes the manifest flat into `--output`, and that dir is almost always
 * a child of the project it belongs to (`app/carveout/` in the demo; whatever
 * `--output` a person passed otherwise). Two levels finds `<project>/carveout/`
 * and `<project>/<anything>/carveout/` without turning a graph request into a
 * tree walk of someone's repo. Deeper than that and the manifest is somewhere
 * behold has no business guessing about.
 *
 * A directory that IS the output dir — the one a `--output` named, or the one
 * a `behold carve <dir>/report.json` pointed at — is scanned flat (depth 0)
 * instead. Walking down from a named output dir would be a guess; walking down
 * from a project root is the convention. */
export const MANIFEST_SCAN_DEPTH = 2;

/** Directories discovery never descends into — vendored trees and dot-dirs
 * hold nothing chant wrote, and walking them is the whole cost of the scan. */
const SKIP_DIRS = new Set(["node_modules", "dist", "cdk.out", ".terraform", ".git"]);

/** Every carve manifest path under `dir`, sorted, bounded by `depth` (default
 * {@link MANIFEST_SCAN_DEPTH}; 0 scans `dir` itself and nothing under it).
 * Unreadable directories are skipped, never fatal. */
export function listCarveManifests(dir: string, io: CarveManifestIo = nodeCarveIo, depth = MANIFEST_SCAN_DEPTH): string[] {
  const out: string[] = [];
  const walk = (d: string, level: number): void => {
    let entries: string[];
    try {
      entries = io.readdir(d).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      if (name.endsWith(CARVE_MANIFEST_SUFFIX)) {
        out.push(full);
        continue;
      }
      if (level >= depth) continue;
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      if (io.isDirectory(full)) walk(full, level + 1);
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * Every carve state discoverable under `dirs`, keyed by Terraform address.
 *
 * One address can only be in one place at a time, so a duplicate (the same
 * target carved into two output dirs) resolves to the FURTHER-ALONG stage:
 * `applied` beats `bridged` beats `emitted`. A half-finished second copy of a
 * carve that already graduated is a stale artifact, not a demotion.
 */
export function readCarveStates(
  dirs: readonly string[],
  io: CarveManifestIo = nodeCarveIo,
  depth = MANIFEST_SCAN_DEPTH,
): Map<string, CarveState> {
  const byTarget = new Map<string, CarveState>();
  for (const dir of dirs) mergeCarveStates(byTarget, listCarveManifests(dir, io, depth), io);
  return byTarget;
}

/** Read each manifest path into `byTarget`, keeping the further-along stage
 * for a duplicated target (see `readCarveStates`). */
function mergeCarveStates(byTarget: Map<string, CarveState>, paths: readonly string[], io: CarveManifestIo): void {
  const rank: Record<CarveStage, number> = { emitted: 0, bridged: 1, applied: 2 };
  for (const path of paths) {
    const manifest = readCarveManifest(path, io.readFile);
    if (!manifest) continue;
    const state = carveStateOf(manifest, path);
    const held = byTarget.get(state.target);
    if (!held || rank[state.stage] > rank[held.stage]) byTarget.set(state.target, state);
  }
}

// ── Discovery through chant (chant#2038, chant ≥ 0.54.0) ─────────────────────

/** The chant that first answers `chant carve status`. */
export const CARVE_STATUS_FLOOR = "0.54.0";

/** One row of `chant carve status --from <dir> --json` — chant's own
 * `CarveStatusRow` (cli/commands/carve-status.ts), reproduced rather than
 * imported, the way every CLI shape behold reads is. */
export interface CarveStatusRow {
  /** Manifest path, relative to the walk root. */
  path: string;
  target: string;
  tfType?: string;
  stage: "planned" | "emitted" | "bridged" | "applied";
  at?: { emit?: string; bridge?: string; apply?: string };
  /** Emitted chant source paths, exactly as the manifest records them. */
  emittedFiles?: string[];
}

/** The `--json` payload: the resolved walk root, one row per readable
 * manifest, and the suffixed files that did not read as one. */
export interface CarveStatusJson {
  from?: string;
  carves?: CarveStatusRow[];
  unreadable?: string[];
}

/** Build the `chant carve status --from <dir> --json` argv. Pure. */
export function carveStatusArgs(from: string): string[] {
  return ["carve", "status", "--from", from, "--json"];
}

/**
 * Every carve state under `dirs`, discovered by chant where it can be and by
 * the bounded local walk where it cannot.
 *
 * `read` is the `chant carve status` call for one root — it answers undefined
 * for a chant below {@link CARVE_STATUS_FLOOR} or a failed read, and then the
 * walk `listCarveManifests` has always done takes over for that root, at
 * `depth`. When chant answers, ITS walk decides which manifests exist (the
 * point of chant#2038: a renderer stops guessing how deep a carveout sits),
 * and behold still reads each manifest itself, because a status row carries
 * the stage and the emitted files but not the excisions, deferred inputs or
 * ownership marker the views render. Same further-along-wins merge as
 * `readCarveStates`.
 */
export async function discoverCarveStates(
  dirs: readonly string[],
  read: (dir: string) => Promise<CarveStatusJson | undefined>,
  io: CarveManifestIo = nodeCarveIo,
  depth = MANIFEST_SCAN_DEPTH,
): Promise<Map<string, CarveState>> {
  const byTarget = new Map<string, CarveState>();
  for (const dir of dirs) {
    const status = await read(dir).catch(() => undefined);
    const paths = status?.carves
      ? status.carves.map((row) => resolve(status.from ?? dir, row.path))
      : listCarveManifests(dir, io, depth);
    mergeCarveStates(byTarget, paths, io);
  }
  return byTarget;
}

// ── The graph join (chant#2040) ───────────────────────────────────────────────

/** What a chant node carries once a carve manifest names the file that
 * declares it — the `_carve` attr the inspect pane reads. */
export interface CarvedFrom {
  /** The Terraform address this entity was carved out of. */
  target: string;
  tfType?: string;
  stage: CarveStage;
  graduated: boolean;
  at?: string;
  /** The Terraform estate it came from, as the manifest recorded it. */
  from?: string;
  /** The emitted file, member-relative — the join key that matched. */
  file: string;
}

/**
 * Join carve manifests onto the chant nodes their emitted files declare.
 *
 * chant#2040's join, by byte comparison: a manifest's `emit.files` are relative
 * to the manifest's own directory (chant#2039), that directory is the emitted
 * project's root, and `chant graph` reports every node's `sourceLoc.file`
 * relative to the same root — so a node whose declaring file is one of a
 * state's `sourceFiles` (resolved against `memberDir`, the project root this
 * IR was graphed from) was carved out of that state's `target`. The node gains
 * `carved` (the address, printed on the card) and `_carve` (the record). Its
 * `_status` is untouched: whether the entity drifts is the overlay's axis, and
 * being carved is provenance, not health.
 *
 * Pure — returns a new IR (nodes shallow-copied) and the count joined, so a
 * cached member IR is never written into. V1 manifests' absolute paths join
 * the same way, since `sourceFiles` is absolute either way.
 */
export function joinCarvedSources(
  ir: GraphIR,
  states: Iterable<CarveState>,
  memberDir: string,
): { ir: GraphIR; joined: number } {
  const root = resolve(memberDir);
  // Only this member's emitted files are candidates; a state from elsewhere
  // can never name a file this IR was graphed from.
  const candidates: Array<{ abs: string; state: CarveState }> = [];
  for (const s of states) {
    for (const f of s.sourceFiles) {
      const abs = resolve(f);
      if (abs === root || abs.startsWith(root + sep)) candidates.push({ abs, state: s });
    }
  }
  if (candidates.length === 0) return { ir, joined: 0 };
  let joined = 0;
  const nodes = ir.nodes.map((n) => {
    const file = n.sourceLoc?.file;
    if (!file) return n;
    const hit = emittedFileFor(file, root, candidates);
    if (!hit) return n;
    joined++;
    const { state, abs } = hit;
    const carve: CarvedFrom = {
      target: state.target,
      ...(state.tfType ? { tfType: state.tfType } : {}),
      stage: state.stage,
      graduated: state.graduated,
      ...(state.at ? { at: state.at } : {}),
      ...(state.from ? { from: state.from } : {}),
      file: relative(root, abs).split(sep).join("/"),
    };
    return { ...n, attrs: { ...n.attrs, carved: state.target, _carve: carve } };
  });
  return { ir: joined ? { ...ir, nodes } : ir, joined };
}

/**
 * Which emitted file a node's `sourceLoc.file` names, if exactly one.
 *
 * chant reports `sourceLoc.file` relative to the directory it was asked to
 * graph — the project root for `chant graph .`, but behold graphs a member
 * from its source dir (`graphPath` prefers `src/`), so the same node reads
 * `assets.ts` here and `src/assets.ts` there. Rather than guess which root was
 * used, the join is a path-segment suffix match under the member: an absolute
 * emitted file matches when it IS `<root>/<file>` or ends in `/<file>`. A
 * `file` that several emitted files end in is ambiguous and joins nothing —
 * stated in the count, never resolved by picking one.
 */
function emittedFileFor(
  file: string,
  root: string,
  candidates: ReadonlyArray<{ abs: string; state: CarveState }>,
): { abs: string; state: CarveState } | undefined {
  const rel = file.split("\\").join("/").replace(/^\.\//, "");
  if (isAbsolute(rel)) {
    const abs = resolve(rel);
    return candidates.find((c) => c.abs === abs);
  }
  const exact = resolve(root, rel);
  const direct = candidates.find((c) => c.abs === exact);
  if (direct) return direct;
  const suffix = candidates.filter((c) => c.abs.split(sep).join("/").endsWith("/" + rel));
  return suffix.length === 1 ? suffix[0] : undefined;
}

/** The real chant node each carve state emitted, keyed by Terraform address —
 * what the carve lens uses to give a graduated card the identity it became. */
export function emittedNodesFor(ir: GraphIR | undefined, states: Iterable<CarveState>, memberDir: string): Map<string, IRNode> {
  const out = new Map<string, IRNode>();
  if (!ir) return out;
  for (const n of joinCarvedSources(ir, states, memberDir).ir.nodes) {
    const carve = n.attrs._carve as CarvedFrom | undefined;
    if (carve && !out.has(carve.target)) out.set(carve.target, n);
  }
  return out;
}

/** The strangler-fig progress read. `total` is the ranked-resource count from
 * the carve report when there is one; without a report there is no denominator
 * and the label says the numerator alone rather than inventing one. */
export interface CarveProgress {
  applied: number;
  bridged: number;
  emitted: number;
  /** Carves started but not graduated — the partial states. */
  inFlight: number;
  total: number | null;
  /** "1 of 12 carved" / "1 carved". */
  label: string;
  /** "1 emitted, 1 bridged — apply is yours", or "" when nothing is in flight. */
  detail: string;
}

export function carveProgress(states: Iterable<CarveState>, total?: number | null): CarveProgress {
  let applied = 0;
  let bridged = 0;
  let emitted = 0;
  for (const s of states) {
    if (s.stage === "applied") applied++;
    else if (s.stage === "bridged") bridged++;
    else emitted++;
  }
  const inFlight = bridged + emitted;
  const parts: string[] = [];
  if (emitted) parts.push(`${emitted} emitted`);
  if (bridged) parts.push(`${bridged} bridged`);
  return {
    applied,
    bridged,
    emitted,
    inFlight,
    total: typeof total === "number" ? total : null,
    label: typeof total === "number" ? `${applied} of ${total} carved` : `${applied} carved`,
    detail: parts.length ? `${parts.join(", ")} — apply is yours` : "",
  };
}

/**
 * The retypeable `chant carve apply` line for a carve in hand.
 *
 * Echoed, never run — {@link APPLY_IS_HUMAN}. `--select` is deliberately
 * absent: the manifest in `--output` already names the target, which is the
 * composition chant#998 shipped and the shortest true command a person can
 * paste. `--env`/`--stack` are shown as placeholders when the manifest has no
 * marker yet, because chant needs them to resolve one and a command that
 * silently omits them would fail in the viewer's terminal, not here.
 *
 * `labels` shortens the two paths for display (the demo prints them relative to
 * its copy, the way every other echoed command in the walkthrough does). It
 * changes what the line READS as, never which carve it names.
 */
export function applyCommandFor(state: CarveState, labels: { from?: string; out?: string } = {}): string {
  const env = state.ownership?.env ?? "<env>";
  const stack = state.ownership?.stack ?? "<stack>";
  const from = labels.from ?? state.from ?? "<terraform-dir>";
  const out = labels.out ?? state.outDir;
  return `chant carve apply --from ${from} --output ${out} --env ${env} --stack ${stack} --write-source`;
}

/** What `/api/project` publishes about the carve state — the same shape in
 * carve mode and on an ordinary project serve, so the panel that renders it
 * has one branch, not two. */
export interface CarveStatePayload {
  manifests: number;
  progress: CarveProgress;
  states: Array<CarveState & { note: string; applyCommand: string }>;
  /** The apply boundary restated on the wire, so an agent reading this sees it
   * without reading the source. There is no endpoint to pair it with — that is
   * the point. */
  apply: { human: true; note: string };
}

/** Build the payload. `labels` shortens each carve's echoed paths for display
 * (the demo prints them relative to its copy); it never changes which carve a
 * state names. */
export function carveStatePayload(
  states: Map<string, CarveState>,
  total?: number | null,
  labels: (s: CarveState) => { from?: string; out?: string } = () => ({}),
): CarveStatePayload {
  const list = [...states.values()].sort((a, b) => a.target.localeCompare(b.target));
  return {
    manifests: list.length,
    progress: carveProgress(list, total),
    states: list.map((s) => ({ ...s, note: carveStageNote(s), applyCommand: applyCommandFor(s, labels(s)) })),
    apply: { human: true, note: APPLY_IS_HUMAN },
  };
}

/**
 * Split a Terraform ranking against the manifest state.
 *
 * A graduated address leaves the TF bands entirely and comes back as a chant
 * node — it keeps its Terraform ADDRESS as its id (the morph's identity
 * continuity, #230 M2b, depends on that), and carries the ownership marker in
 * its attrs so the inspect pane can say who owns it and since when.
 *
 * A partial address stays in its band — nothing has changed hands — but its
 * card is repainted: the in-flight tone plus the stage's word in the `carve`
 * field the presentation pack already shows.
 *
 * Boundary edges to a graduated node are dropped along with it. The edge
 * described a cut that has now been made; drawing it would claim the survivor
 * still reads the Terraform resource, which after `carve bridge` + `apply` it
 * does not.
 */
export function splitCarveState(
  tfIr: GraphIR,
  states: Map<string, CarveState>,
  // The emitted source path lands on the card, and chant records it absolute.
  // `shorten` is how a caller trims it to something a viewer learns from —
  // `app/carveout/src/assets.ts` rather than the length of an operator's
  // tmpdir. Identity, not redaction: the same presentation choice
  // src/carve-actions.ts makes for every command it echoes.
  opts: { shorten?: (path: string) => string; emitted?: Map<string, IRNode> } = {},
): { tf: GraphIR; graduated: IRNode[] } {
  if (states.size === 0) return { tf: tfIr, graduated: [] };
  const shorten = opts.shorten ?? ((p: string) => p);
  // chant#2040: the chant node the carve actually emitted, when the emitted
  // project could be graphed. A graduated card keeps its Terraform address as
  // its id (the morph's identity continuity) and takes on the entity it
  // became — kind, lexicon, declared attrs, source location — so the card in
  // the chant box reads as chant source, not as a Terraform address wearing a
  // green fill. A partial carve only names the entity; nothing changed hands.
  const emitted = opts.emitted ?? new Map<string, IRNode>();
  const declaredAttrs = (n: IRNode): Record<string, unknown> =>
    Object.fromEntries(Object.entries(n.attrs ?? {}).filter(([k]) => !k.startsWith("_") && k !== "carved"));
  const source = (files: string[]): string => files.map(shorten).join(", ");
  const gone = new Set<string>();
  const graduated: IRNode[] = [];
  const nodes: IRNode[] = [];

  for (const node of tfIr.nodes) {
    const state = states.get(node.id);
    if (!state) {
      nodes.push(node);
      continue;
    }
    const became = emitted.get(node.id);
    if (state.graduated) {
      gone.add(node.id);
      graduated.push({
        ...node,
        ...(became ? { kind: became.kind, lexicon: became.lexicon, ...(became.sourceLoc ? { sourceLoc: became.sourceLoc } : {}) } : {}),
        attrs: {
          ...node.attrs,
          ...(became ? { ...declaredAttrs(became), chantEntity: `${became.kind} ${became.id}` } : {}),
          _status: "good",
          carve: carveWordFor(state.stage),
          carveState: state.stage,
          ...(state.ownership?.stack ? { ownedStack: state.ownership.stack } : {}),
          ...(state.ownership?.env ? { ownedEnv: state.ownership.env } : {}),
          ...(state.at ? { carvedAt: state.at } : {}),
          ...(state.files.length ? { chantSource: source(state.files) } : {}),
        },
      });
      continue;
    }
    nodes.push({
      ...node,
      attrs: {
        ...node.attrs,
        _status: carveToneFor(state.stage),
        carve: carveWordFor(state.stage),
        carveState: state.stage,
        ...(became ? { chantEntity: `${became.kind} ${became.id}` } : {}),
        ...(state.at ? { carvedAt: state.at } : {}),
        ...(state.files.length ? { chantSource: source(state.files) } : {}),
        ...(state.excised.length ? { excisesOnApply: state.excised.join(", ") } : {}),
        ...(state.deferredInputs.length ? { deferredInputs: state.deferredInputs.join(", ") } : {}),
      },
    });
  }

  const byStack: Record<string, string[]> = {};
  for (const [band, members] of Object.entries((tfIr.groups?.byStack ?? {}) as Record<string, string[]>)) {
    const left = members.filter((id) => !gone.has(id));
    if (left.length) byStack[band] = left;
  }

  return {
    tf: {
      nodes,
      edges: tfIr.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
      groups: { ...tfIr.groups, byStack },
    },
    graduated,
  };
}

/** The band a graduated resource lands in when there is no chant box to move
 * it into — the same words the estate frame paints on the card. */
export const GRADUATED_BAND = "carved → chant";

/**
 * The single-view answer to the split (`behold carve report.json`, no demo).
 *
 * There is no chant member box to move a graduated card into, and dropping it
 * would be worse than either option — the resource did not stop existing, it
 * stopped being Terraform's. So it gets its own band, ABOVE the ranking, which
 * is where the picture reads as a progress bar: the graduated pile grows at the
 * top while the bands below it drain.
 */
export function bandGraduated(tf: GraphIR, graduated: IRNode[]): GraphIR {
  if (graduated.length === 0) return tf;
  return {
    nodes: [...graduated, ...tf.nodes],
    edges: tf.edges,
    groups: {
      ...tf.groups,
      byStack: {
        [GRADUATED_BAND]: graduated.map((n) => n.id),
        ...((tf.groups?.byStack ?? {}) as Record<string, string[]>),
      },
    },
  };
}

/** The manifest half of the statusbar's honesty line, or "" when no carve has
 * been recorded at all. Appended to `carveNote`'s advisory reading. */
export function carveStateNote(progress: CarveProgress, states: Map<string, CarveState>): string {
  if (states.size === 0) return "";
  const head = ` Carve state (from ${states.size} manifest${states.size === 1 ? "" : "s"}): ${progress.label}`;
  return progress.detail ? `${head}, ${progress.detail}.` : `${head}.`;
}
