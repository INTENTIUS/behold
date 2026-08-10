/**
 * The carve lens (#252, M1 of #230) — render a chant Terraform peelability
 * report as a behold graph.
 *
 * behold never parses Terraform. `chant carve advise --json` already ranks each
 * resource/module by how cheaply it could be carved into native chant source,
 * and that report IS the contract: addresses, scores, bands, the penalty
 * arithmetic behind each score, a `version`, and the per-resource `boundary`
 * edge lists (chant#1636, chant PR #1639) naming the boundary edges a carve
 * would cut. This module converts that JSON into a `GraphIR` the existing
 * painter and SPA already know how to draw — no new frontend, no Terraform
 * tooling in behold's dependency tree.
 *
 * What the picture says:
 *  - one card per ranked resource/module, `kind` = the Terraform type
 *    (`aws_s3_bucket`), lexicon `terraform`
 *  - the band rides `attrs._status`, so the drift palette colours it: carve-now
 *    green (`good`), boundary-work amber (`warn`), leave-in-Terraform grey
 *    (`neutral`) — the same vocabulary every other behold view paints
 *  - one boundary box per band (`groups.byStack`), so the ranking reads as the
 *    banded list the CLI prints
 *  - the score arithmetic lands in `attrs`, which the inspect pane renders as
 *    its "declared" section with no client change
 *
 * Folded sub-resources (an `aws_s3_bucket_versioning` inlined into its bucket)
 * never appear: chant already dropped them from the ranking, because they carve
 * with their parent rather than on their own.
 */
import type { GraphIR, IRNode, IREdge } from "@intentius/chant";

/** How a band paints. The three `_status` tokens #252 specifies. */
export type CarveStatus = "good" | "warn" | "neutral";

/**
 * One dependency edge a carve would cut, as chant's own `boundaryReport`
 * classifies it (packages/core/src/terraform/carve.ts `BoundaryEdge`).
 *
 * A chant that predates chant#1636 publishes only per-resource inbound/outbound
 * COUNTS (see `CarveBreakdown`) with no `boundary` field at all — there is no
 * pairing to draw from, and this lens emits no edges for that report (see
 * `carveNote`'s caveat). A chant with #1636 (chant PR #1639) publishes this
 * shape per resource, and every cut is reported from BOTH endpoints: once as
 * an `inbound` edge on the depended-on resource, once as an `outbound` edge on
 * the resource that depends on it — `carveReportToIr` dedups the two views of
 * one cut into a single edge. Every field is optional except the two
 * endpoints — a renderer should never harden a contract it doesn't own more
 * than it must.
 */
export interface CarveBoundaryEdge {
  /** `inbound` = a survivor depends on the carve set; `outbound` = the reverse. */
  direction?: "inbound" | "outbound";
  /** The surviving-Terraform side of the edge. */
  survivor: string;
  /** The carve-set side of the edge. */
  carved: string;
  /** Producer-side attribute path(s) referenced, e.g. `["id", "arn"]`. */
  attrs?: string[];
  /** The referring block's own attribute(s) the reference sits in, e.g. `["vpc_id"]`. */
  via?: string[];
  /** `tf-data-source` (patch the survivor now) or `deferred-input` (at apply). */
  bridge?: string;
  /** `immediately` or `at-apply`. */
  required?: string;
}

/** The signed penalty contributions behind a score (chant's `PeelabilityBreakdown`). */
export interface CarvePenalties {
  inbound?: number;
  outbound?: number;
  tier?: number;
  dynamic?: number;
  instances?: number;
}

/** What drove a resource's score (chant's `PeelabilityBreakdown`). */
export interface CarveBreakdown {
  /** Survivors that depend on this — a Terraform `data`-source patch each. */
  inbound?: number;
  /** Survivors this depends on — a deferred deploy-time input each. */
  outbound?: number;
  /** Native-spec map difficulty: 1 clean, 2 reshaping, 3 hard, null unmappable. */
  tier?: 1 | 2 | 3 | null;
  /** `count` / `for_each` / a `data` source is present. */
  hasDynamic?: boolean;
  /** State-expanded instance count. */
  instances?: number;
  penalties?: CarvePenalties;
}

/** One ranked resource or module (chant's `Peelability`). */
export interface CarveResource {
  /** Terraform address — `aws_s3_bucket.assets`, `module.cdn`. The node id. */
  address: string;
  kind?: "resource" | "module";
  score: number;
  band: string;
  /** The native chant/spec type a carve would target. Absent for modules/unmappable. */
  mapsTo?: string;
  breakdown?: CarveBreakdown;
  /**
   * The boundary edges this resource's carve would cut — chant#1636's ask.
   * Either a flat list or split by direction; both are read (see the note on
   * {@link CarveBoundaryEdge}).
   */
  boundary?: CarveBoundaryEdge[] | { inbound?: CarveBoundaryEdge[]; outbound?: CarveBoundaryEdge[] };
}

/** The `chant carve advise --json` payload. */
export interface CarveReport {
  /**
   * Schema version — chant#1636's ask. ABSENT on every chant that predates it,
   * which this lens accepts (that is the whole point of asking for the field:
   * a renderer can then refuse a future major politely instead of misreading it).
   */
  version?: number | string;
  /** The Terraform estate directory the advisor read. */
  from?: string;
  advisory?: string;
  count?: number;
  /** band name -> how many resources landed in it. */
  bands?: Record<string, number>;
  resources: CarveResource[];
}

/** The one schema major this lens knows how to read. */
const SUPPORTED_MAJOR = 1;

/** A refusal: why the file isn't a carve report, and what to do instead. #193's
 * structured-error standard — `{error, code, remedy}`, the shape the SPA's
 * precondition card renders and the CLI prints. */
export interface CarveRefusal {
  error: string;
  code: "carve-report";
  remedy: string;
}

export type CarveParse = { ok: true; report: CarveReport } | { ok: false; refusal: CarveRefusal };

const refuse = (error: string, remedy: string): CarveParse => ({ ok: false, refusal: { error, code: "carve-report", remedy } });

/** The remedy every shape refusal ends with — where a real report comes from. */
const HOW_TO_GET_ONE =
  "Generate one with `chant carve advise --from <terraform-dir> --report report.json` " +
  "(chant's read-only Terraform peelability advisor), then `behold carve report.json`.";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate an already-parsed JSON value as a carve report, or refuse politely.
 *
 * Deliberately shallow: it checks the handful of fields the lens actually reads
 * (a `resources` array whose entries carry an address, a score and a band), not
 * every field chant emits. A renderer that demands more than it uses breaks on
 * the first additive field the producer ships.
 *
 * The version check is the reverse of that leniency and is why chant#1636 was
 * asked for: an ABSENT version is accepted (every chant to date), a version
 * whose major this lens knows is accepted, and anything else is refused rather
 * than half-read.
 */
export function parseCarveReport(value: unknown): CarveParse {
  if (!isRecord(value)) {
    return refuse("That file isn't a carve report — its top level isn't a JSON object.", HOW_TO_GET_ONE);
  }
  // Shape before version, deliberately. Plenty of JSON files carry a `version`
  // (every package.json does), and "behold reads version 1" is a baffling thing
  // to say about a file that was never a carve report at all. The version check
  // only earns its keep once the thing in hand looks like one.
  if (!Array.isArray(value.resources)) {
    return refuse(
      "That JSON doesn't look like a carve report — it has no `resources` array.",
      HOW_TO_GET_ONE,
    );
  }
  const bad = (value.resources as unknown[]).findIndex(
    (r) => !isRecord(r) || typeof r.address !== "string" || typeof r.score !== "number" || typeof r.band !== "string",
  );
  if (bad >= 0) {
    return refuse(
      `That JSON has a \`resources\` array, but entry ${bad} isn't a scored resource (needs a string \`address\`, a numeric \`score\` and a string \`band\`).`,
      HOW_TO_GET_ONE,
    );
  }
  const version = value.version ?? value.schemaVersion;
  if (version !== undefined) {
    const major = Number(String(version).split(".")[0]);
    if (!Number.isFinite(major) || major !== SUPPORTED_MAJOR) {
      return refuse(
        `This carve report declares schema version ${String(version)}; behold reads version ${SUPPORTED_MAJOR}.`,
        "Upgrade behold, or render the report with a behold that speaks its version.",
      );
    }
  }
  return { ok: true, report: value as unknown as CarveReport };
}

/** Read + parse a report file, refusing politely on anything unreadable. */
export function readCarveReport(path: string, readFile: (p: string) => string): CarveParse {
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    return refuse(
      `Couldn't read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      HOW_TO_GET_ONE,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return refuse(
      `${path} isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      HOW_TO_GET_ONE,
    );
  }
  return parseCarveReport(json);
}

/**
 * Band -> paint. Keyed on chant's own band names, with a score-threshold
 * fallback (the model documented in chant's carve CLI page: 80-100 carve now,
 * 50-79 boundary work, 0-49 leave) so a renamed or added band still colours
 * something honest instead of falling through to no status at all.
 */
export function statusForBand(band: string, score: number): CarveStatus {
  switch (band) {
    case "clean leaf":
      return "good";
    case "carvable w/ edits":
      return "warn";
    case "leave in Terraform":
      return "neutral";
    default:
      return score >= 80 ? "good" : score >= 50 ? "warn" : "neutral";
  }
}

/** The band's verdict in plain words — the boundary-box title, and the card's
 * second field. Short enough for both. */
export function verdictForStatus(status: CarveStatus): string {
  return status === "good" ? "carve now" : status === "warn" ? "boundary work" : "leave in Terraform";
}

/**
 * The Terraform type out of an address: `aws_s3_bucket.assets` -> `aws_s3_bucket`,
 * `module.cdn` -> `module`. The node's `kind`, so pinhole's keyword glyph
 * heuristic gets something to work with (bucket, vpc, subnet, function all
 * resolve) and the inspect pane's identity block names the real Terraform type.
 */
export function tfTypeOf(address: string, kind?: string): string {
  if (kind === "module" || address.startsWith("module.")) return "module";
  const dot = address.indexOf(".");
  return dot > 0 ? address.slice(0, dot) : address;
}

/**
 * An edge's direction, defaulting to `inbound` when the producer omitted it.
 *
 * The default is not a guess dressed up as a fact: a resource's boundary list
 * carries both directions and every entry names the same carve-set side, so
 * there is nothing in the edge itself to infer from. `inbound` is the
 * conservative read — it claims the survivor needs an immediate data-source
 * patch, which is the reading that gets someone to look rather than the one
 * that lets a cut slip past as "deferred until apply".
 */
const directionOf = (e: CarveBoundaryEdge): "inbound" | "outbound" => e.direction ?? "inbound";

/** Every boundary edge a resource declares, whichever of the two shapes it uses. */
function boundaryEdgesOf(r: CarveResource): CarveBoundaryEdge[] {
  const b = r.boundary;
  if (!b) return [];
  const list = Array.isArray(b) ? b : [...(b.inbound ?? []), ...(b.outbound ?? [])];
  return list.filter((e) => isRecord(e) && typeof e.survivor === "string" && typeof e.carved === "string");
}

/**
 * The score, spelled out. chant itemizes every penalty term in `breakdown.
 * penalties`, so the arithmetic can be reproduced rather than re-derived:
 * `100 - 12x1 inbound = 88`. A resource with no native mapping scored 0 with no
 * penalties at all (chant awards no partial credit), which reads as itself.
 */
export function scoreArithmetic(r: CarveResource): string {
  const b = r.breakdown;
  if (!b || b.tier === null) return `${r.score} (no known native mapping — nothing to carve into)`;
  const p = b.penalties ?? {};
  const terms: string[] = [];
  if (p.inbound) terms.push(`- 12x${b.inbound ?? 0} inbound`);
  if (p.outbound) terms.push(`- 4x${b.outbound ?? 0} outbound`);
  if (p.tier) terms.push(`- 15x${(b.tier ?? 1) - 1} tier${b.tier}`);
  if (p.dynamic) terms.push(`- 10 dynamic`);
  if (p.instances) terms.push(`- 3x${(b.instances ?? 1) - 1} instances`);
  if (!terms.length) return `100 (no penalties) = ${r.score}`;
  const raw = 100 + Object.values(p).reduce((s, n) => s + (n ?? 0), 0);
  // chant clamps to 0..100; say so rather than printing arithmetic that doesn't
  // add up to the score beside it.
  const clamped = raw !== r.score ? ` (clamped from ${raw})` : "";
  return `100 ${terms.join(" ")} = ${r.score}${clamped}`;
}

/** The one-line "what drove this score" chant's own console report prints. */
export function boundaryWorkOf(r: CarveResource): string {
  const b = r.breakdown;
  if (!b || b.tier === null) return "no known native mapping (unsupported provider/type)";
  const parts: string[] = [];
  if (b.inbound) parts.push(`${b.inbound} inbound (a data-source patch each)`);
  if (b.outbound) parts.push(`${b.outbound} outbound (a deferred input each)`);
  if ((b.tier ?? 1) > 1) parts.push(`tier ${b.tier} map`);
  if (b.hasDynamic) parts.push("count/for_each/data present");
  if ((b.instances ?? 1) > 1) parts.push(`${b.instances} instances`);
  return parts.length ? parts.join(", ") : "clean 1:1 native map, no boundary edges";
}

/** The two fields a carve card shows (pinhole presentation pack, registered in
 * src/render.ts) — the score and the verdict, in that order, whatever the attr
 * map's alphabetical order happens to be. */
export function carveCardFields(node: { attrs: Record<string, unknown> }): Array<{ label: string; value: string }> | undefined {
  const score = node.attrs.score;
  const carve = node.attrs.carve;
  if (typeof score !== "number") return undefined;
  return [
    { label: "score", value: String(score) },
    ...(typeof carve === "string" ? [{ label: "carve", value: carve }] : []),
  ];
}

/**
 * Convert a peelability report into a graph IR.
 *
 * Nodes are the ranked resources/modules; edges are the boundary edges, drawn
 * in the direction the dependency actually runs (a survivor points AT the piece
 * it would lose) and tagged `viaAttr: "inbound" | "outbound"` — the SPA already
 * renders `viaAttr` as the edge's hover tooltip and dashed style, so the
 * predicted cut reads without a client change. Edges whose other end isn't a
 * ranked node are dropped rather than minting a phantom card.
 */
export function carveReportToIr(report: CarveReport): GraphIR {
  const resources = report.resources ?? [];
  const known = new Set(resources.map((r) => r.address));

  const nodes: IRNode[] = resources.map((r) => {
    const status = statusForBand(r.band, r.score);
    const b = r.breakdown ?? {};
    const edges = boundaryEdgesOf(r);
    const patches = edges.filter((e) => e.carved === r.address && directionOf(e) === "inbound").map((e) => e.survivor);
    const inputs = edges.filter((e) => e.carved === r.address && directionOf(e) === "outbound").map((e) => e.survivor);
    return {
      id: r.address,
      kind: tfTypeOf(r.address, r.kind),
      lexicon: "terraform",
      attrs: {
        // The drift palette's channel — `_`-prefixed, so it paints the card and
        // stays out of both the card's fields and the inspect pane's list.
        _status: status,
        score: r.score,
        carve: verdictForStatus(status),
        band: r.band,
        arithmetic: scoreArithmetic(r),
        boundaryWork: boundaryWorkOf(r),
        ...(r.mapsTo ? { mapsTo: r.mapsTo } : {}),
        tier: b.tier === null || b.tier === undefined ? "none" : b.tier,
        inbound: b.inbound ?? 0,
        outbound: b.outbound ?? 0,
        instances: b.instances ?? 1,
        dynamic: b.hasDynamic ?? false,
        // The predicted diff, when the report carries the edge lists: who needs
        // a `data` source the moment this is carved, and what becomes a
        // deploy-time input. Absent (not empty) when the report has no lists —
        // "none" and "not reported" are different claims.
        ...(patches.length ? { patchOnCarve: patches.join(", ") } : {}),
        ...(inputs.length ? { deferredInputs: inputs.join(", ") } : {}),
      },
    };
  });

  // Boundary edges, deduped: the same edge is reported by both endpoints once
  // chant publishes per-resource lists.
  const seen = new Set<string>();
  const edges: IREdge[] = [];
  for (const r of resources) {
    for (const e of boundaryEdgesOf(r)) {
      const direction = directionOf(e);
      // `from` references `to` — an inbound edge is a survivor reaching into
      // the carve set, an outbound edge is the carve set reaching out.
      const from = direction === "inbound" ? e.survivor : e.carved;
      const to = direction === "inbound" ? e.carved : e.survivor;
      if (!known.has(from) || !known.has(to)) continue;
      // `from`/`to` are already computed in dependency direction, so both
      // views of one cut (the depended-on's `inbound` entry and the
      // depender's `outbound` entry) produce the identical pair here even
      // though `direction` itself differs between them. Key on the pair
      // alone — including `direction` would let the same cut draw twice.
      const key = `${from}|${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from,
        to,
        kind: "ref",
        viaAttr: direction,
        ...(e.attrs?.length ? { toAttr: e.attrs.join(", ") } : {}),
      });
    }
  }

  // One boundary box per band, in carve-now -> leave order, so the picture
  // reads top-to-bottom like the CLI's banded ranking. `byStack` (not `byWave`)
  // because render.ts boxes `byWave` automatically and this is an explicit
  // opt-in — see renderGraph's doc comment.
  const byStack: Record<string, string[]> = {};
  for (const order of ["good", "warn", "neutral"] as CarveStatus[]) {
    const members = resources.filter((r) => statusForBand(r.band, r.score) === order).map((r) => r.address);
    if (members.length) byStack[verdictForStatus(order)] = members;
  }

  return { nodes, edges, groups: { byStack } };
}

/** The one-line summary the server puts on `meta.note` — the statusbar's
 * honesty about what this graph is, including the missing edge lists. */
export function carveNote(report: CarveReport, ir: GraphIR): string {
  const counts = Object.entries(report.bands ?? {})
    .filter(([, n]) => n > 0)
    .map(([band, n]) => `${n} ${band}`)
    .join(" · ");
  const head = `chant carve advisory${report.from ? ` for ${report.from}` : ""}${counts ? ` — ${counts}` : ""}`;
  if (ir.edges.length) return `${head}. Read-only: nothing is emitted, patched, or applied.`;
  return (
    `${head}. This report carries per-resource boundary COUNTS but no edge lists, ` +
    `so no boundary edges are drawn (chant#1636). Read-only: nothing is emitted, patched, or applied.`
  );
}
