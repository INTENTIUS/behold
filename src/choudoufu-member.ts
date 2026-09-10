/**
 * The choudoufu estate member (#369, M1 of #366).
 *
 * choudoufu is an OpenTofu fork whose ownership lives on the resource as two
 * AWS tags, `tofu-estate` and `tofu-address`; the state file is a cache that
 * is allowed to be stale. An estate is declared once per directory — in the
 * `estate.chdf.hcl` sidecar, choudoufu's leading form, or in a `live { estate
 * = "..." }` block in a root *.tf — and one estate is one member box in
 * behold's estate compose.
 *
 * This module reads the DECLARED half: `choudoufu live-check -json`, which
 * makes no cloud call and reads no state. The document is the roster (every
 * declared instance with its rung) and the edge set (`references[]`: every
 * data source filtered on another estate's marker tags, with the resources
 * that read it). behold parses no HCL, by design — the carve lens made
 * `chant carve advise --json` the contract for the same reason, and choudoufu
 * shaped this document for exactly that reader (its Go doc comments say so).
 *
 * Painted nothing: M1 draws the roster and the edges, and every card is
 * uncoloured until the live half (#370, M2: `live-ls` and `live-plan`) says
 * what the account holds. A live or overlay read of this member therefore
 * REFUSES rather than guesses, so `composeEstateOverlay` paints its source
 * graph `neutral` with the reason in the cover note — the same honest
 * "did not look" every unobserved member gets.
 *
 * The floor is choudoufu v0.16.0: the release that carries `schemas` on this
 * document (choudoufu#966), `choudoufu_version` on `version -json`
 * (choudoufu#968) and uniform `identity` on `live-plan -json` (choudoufu#967).
 * All three landed on choudoufu main after the v0.15.0 tag, so a build from
 * main is accepted meanwhile: the check is the FIELD, not the number — a
 * document with no `schemas` key is one an older choudoufu wrote.
 *
 * Imports nothing from src/chant.ts at runtime (see src/member-kind.ts's
 * header for the cycle that rule exists for); the spawn helper is its own.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { stripAnsi } from "./ansi.ts";
import type { GraphOptions } from "./chant.ts";
import { meetsFloor } from "./floor.ts";

/** The lexicon every node this member emits carries — the presentation pack
 * (src/render.ts) and the inspect pane key on it. */
export const CHOUDOUFU_LEXICON = "choudoufu";

/** The release whose `-json` documents carry every field this member reads. */
export const CHOUDOUFU_FLOOR = "0.16.0";

/** `instances[].rung`, pinned (choudoufu `internal/live/check/roster.go`).
 * A fourth value, the empty string, is a refused site with no recovered type
 * and comes through as an absent key. The test on this union fails the day
 * choudoufu adds a word, which is the point. */
export const RUNGS = ["tag-governable", "declaration-carried", "record-only"] as const;
export type Rung = (typeof RUNGS)[number];

/** `schemas`: what the rungs were computed from (choudoufu#966). `builtin`
 * means no `choudoufu init` has run in the directory, so the rung table is
 * choudoufu's own and reads every taggable type as `declaration-carried`. */
export const SCHEMA_SOURCES = ["provider", "builtin"] as const;
export type SchemaSource = (typeof SCHEMA_SOURCES)[number];

export interface LiveCheckInstance {
  address: string;
  type?: string;
  rung?: string;
  refused?: boolean;
  rule?: string;
  reason?: string;
}

/** One cross-estate edge, stated by the tool: a data source (`from`) whose
 * filters name a producer estate's marker tags, and the resources in this
 * estate that read it. `address` is absent when only `tag:tofu-estate` is
 * filtered — a reference to an estate, not to an instance in it. */
export interface LiveCheckReference {
  from: string;
  estate: string;
  address?: string;
  read_by?: string[];
}

export interface LiveCheckDocument {
  dir: string;
  estate?: string;
  blocked: boolean;
  exit_code: number;
  schemas: SchemaSource;
  instances: LiveCheckInstance[];
  references: LiveCheckReference[];
  checked: string[];
  partial?: string[];
  unchecked?: string[];
}

/** #193's structured error: why this is not a live-check document, and what
 * to do — the shape the SPA's precondition card renders and doctor prints. */
export interface ChoudoufuRefusal {
  error: string;
  code: "choudoufu-live-check";
  remedy: string;
}

export type LiveCheckParse = { ok: true; doc: LiveCheckDocument } | { ok: false; refusal: ChoudoufuRefusal };

const refuse = (error: string, remedy: string): LiveCheckParse => ({ ok: false, refusal: { error, code: "choudoufu-live-check", remedy } });

const INSTALL = `Install choudoufu ${CHOUDOUFU_FLOOR} or newer (https://github.com/INTENTIUS/choudoufu) and put it on PATH, or point CHOUDOUFU_BIN at a build from main.`;
const INIT = (dir: string): string => `Run \`choudoufu init -input=false\` in ${dir} so the rungs come from the provider's schemas.`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate an already-parsed JSON value as a `live-check -json` document, or
 * refuse politely. Shallow on purpose — the fields this member reads, not
 * every field choudoufu emits — except for one: `schemas` must be present,
 * because a document without it is one a choudoufu older than the floor
 * wrote, and its rungs cannot be told from a directory that was never
 * initialised.
 */
export function parseLiveCheck(value: unknown): LiveCheckParse {
  if (!isRecord(value)) return refuse("That is not a live-check document — its top level is not a JSON object.", INSTALL);
  if (!Array.isArray(value.instances) || !Array.isArray(value.references)) {
    return refuse("That JSON is not a live-check document — it has no `instances` and `references` arrays.", INSTALL);
  }
  const bad = (value.instances as unknown[]).findIndex((i) => !isRecord(i) || typeof i.address !== "string");
  if (bad >= 0) return refuse(`live-check's instances[${bad}] has no string \`address\`.`, INSTALL);
  const badRef = (value.references as unknown[]).findIndex((r) => !isRecord(r) || typeof r.from !== "string" || typeof r.estate !== "string");
  if (badRef >= 0) return refuse(`live-check's references[${badRef}] has no string \`from\` and \`estate\`.`, INSTALL);
  if (!(SCHEMA_SOURCES as readonly unknown[]).includes(value.schemas)) {
    return refuse(
      `This live-check document carries no \`schemas\` field, so its rungs cannot be trusted: it was written by a choudoufu older than ${CHOUDOUFU_FLOOR}.`,
      INSTALL,
    );
  }
  return { ok: true, doc: value as unknown as LiveCheckDocument };
}

/** What a spawn returned. */
export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/** Turn a `live-check -json` run into a document or a refusal. An empty stdout
 * with a non-zero exit is "could not be read" — choudoufu prints nothing for a
 * directory that will not parse, because a document with an empty roster
 * would read as "zero instances declared", which is a worse lie — and that is
 * a different refusal from a document that says `blocked: true`. */
/** choudoufu's stderr as bare lines: colour stripped, the box-drawing gutter
 * its diagnostics wear removed, blank and rule-only lines dropped. */
export function stripAnsiLines(stderr: string): string[] {
  return stripAnsi(stderr)
    .split("\n")
    .map((l) => l.replace(/^[│╷╵\s]+/, "").trim())
    .filter((l) => l && !/^[─╷╵│]+$/.test(l));
}

export function parseLiveCheckOutput(run: Captured, dir: string): LiveCheckParse {
  if (run.code === 127) return refuse(`choudoufu is not on PATH (${stripAnsi(run.stderr).trim() || "spawn failed"}).`, INSTALL);
  const text = run.stdout.trim();
  if (!text) {
    const said = stripAnsiLines(run.stderr);
    const why = said.find((l) => /^Error:/.test(l)) ?? said[0] ?? `exit ${run.code}`;
    return refuse(`choudoufu could not read ${dir}: ${why}`, "Fix the configuration until `choudoufu live-check` prints a document, then reload.");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return refuse(`choudoufu live-check printed something that is not JSON: ${err instanceof Error ? err.message : String(err)}`, INSTALL);
  }
  return parseLiveCheck(json);
}

/** Read the file names in a directory, or nothing for one that cannot be read. */
function tfFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".tf"));
  } catch {
    return [];
  }
}

const LIVE_BLOCK = /^\s*live\s*\{/m;

/** choudoufu's leading estate declaration (#387): a sidecar beside the root
 * `*.tf` files carrying `estate = "…"` and the record store. choudoufu's own
 * reference calls it the leading form; `tools/estate-gen` writes one into
 * every cohort and a migrated terralith carries one, which is why a probe
 * that knew only the `live` block missed the estates behold is developed
 * against. */
export const ESTATE_SIDECAR = "estate.chdf.hcl";

/** Does `dir` look like a choudoufu estate: the `estate.chdf.hcl` sidecar in
 * the directory, or — the other spelling, still supported — a root `*.tf`
 * with a `live { … }` block. Either is enough; both at once is an error
 * choudoufu itself reports, and not this probe's business.
 *
 * The sidecar half is the file's presence, nothing read. The `live` half is
 * unchanged: a regex, not a parse — behold reads no HCL — over root files
 * only, because that is where choudoufu requires the block to be. */
export function isChoudoufuEstate(dir: string): boolean {
  if (existsSync(join(dir, ESTATE_SIDECAR))) return true;
  for (const f of tfFiles(dir)) {
    try {
      if (LIVE_BLOCK.test(readFileSync(join(dir, f), "utf8"))) return true;
    } catch {
      // unreadable file: not evidence either way
    }
  }
  return false;
}

/** `data.aws_vpc.network` → `data.aws_vpc`: the kind a data-source card shows. */
export function dataSourceKind(from: string): string {
  const parts = from.split(".");
  return parts.length >= 3 && parts[0] === "data" ? `data.${parts[1]}` : from;
}

/**
 * The document as a graph IR.
 *
 * Nodes: one per declared instance (`id` the address, `kind` the type, the rung
 * and the estate in `attrs`, so the inspect pane's "declared" section shows
 * them with no client change), plus one per cross-estate reference — the data
 * source, as a card of its own, carrying `producer: {estate, address}` for the
 * estate pass below to resolve. Edges: each reader to the data source it reads
 * (`viaAttr: "reads"`), the same direction as a `$ref` edge.
 *
 * No `_status`: this is the declared half, and colour is the live half's to
 * give (#370). `schemas: "builtin"` lands in `attrs` as a caveat so the pane
 * says the rungs came from the built-in table; a doctor line carries the
 * remedy.
 */
export function liveCheckToIr(doc: LiveCheckDocument): GraphIR {
  const estate = doc.estate;
  const caveat = doc.schemas === "builtin" ? { schemas: "builtin (no provider schemas; rungs from choudoufu's own table)" } : {};
  const nodes: GraphIR["nodes"] = doc.instances.map((i) => ({
    id: i.address,
    kind: i.type ?? "unknown",
    lexicon: CHOUDOUFU_LEXICON,
    attrs: {
      ...(estate ? { estate } : {}),
      ...(i.rung ? { rung: i.rung } : {}),
      ...(i.refused ? { refused: true, ...(i.rule ? { rule: i.rule } : {}), ...(i.reason ? { reason: i.reason } : {}) } : {}),
      ...caveat,
    },
  }));
  const edges: GraphIR["edges"] = [];
  const ids = new Set(nodes.map((n) => n.id));
  for (const r of doc.references) {
    if (!ids.has(r.from)) {
      ids.add(r.from);
      nodes.push({
        id: r.from,
        kind: dataSourceKind(r.from),
        lexicon: CHOUDOUFU_LEXICON,
        attrs: {
          ...(estate ? { estate } : {}),
          producer: { estate: r.estate, ...(r.address ? { address: r.address } : {}) },
        },
      });
    }
    for (const reader of r.read_by ?? []) {
      if (ids.has(reader)) edges.push({ from: reader, to: r.from, kind: "ref", viaAttr: "reads" });
    }
  }
  return { nodes, edges, groups: {} };
}

/**
 * The cross-member edge (#366's open join, closed here): a reference names a
 * producer ESTATE, and the estate compose knows which member box carries which
 * estate name — every choudoufu node carries `attrs.estate`. For each data
 * source whose producer is a member of this estate, an edge to the producing
 * instance's composed id; one whose producer is not a member keeps the fact as
 * an inspect row (`unresolved`) and gets no dangling edge. Joins on attribute
 * values, never ids, so `composeStacks`' prefixes pass through, and runs after
 * `addEstateMemberEdges` in both estate routes (`/api/graph`, `/api/overlay`),
 * which must stay identical. Additive: an estate with no choudoufu member gets
 * the same IR back.
 */
export function addChoudoufuReferenceEdges(ir: GraphIR): GraphIR {
  const byId = new Map(ir.nodes.map((n) => [n.id, n] as const));
  const memberOfEstate = new Map<string, string>();
  for (const [member, ids] of Object.entries(ir.groups.byStack ?? {})) {
    for (const id of ids) {
      const n = byId.get(id);
      const estate = n?.lexicon === CHOUDOUFU_LEXICON ? n.attrs.estate : undefined;
      if (typeof estate === "string" && !memberOfEstate.has(estate)) memberOfEstate.set(estate, member);
    }
  }
  const have = new Set(ir.edges.map((e) => `${e.from}|${e.to}`));
  const link = (from: string, to: string, viaAttr: string): void => {
    if (have.has(`${from}|${to}`)) return;
    have.add(`${from}|${to}`);
    ir.edges.push({ from, to, kind: "ref", viaAttr, inferred: true } as never);
  };
  for (const n of ir.nodes) {
    if (n.lexicon !== CHOUDOUFU_LEXICON) continue;
    // #370: a live object at this address is owned by ANOTHER estate
    // (`unowned[].tofu_estate`). When that estate is a sibling member that
    // declares the same address, the card the object really belongs to is on
    // the picture — a dashed edge says so; the moved-but-block-not-yet-removed
    // state after a `live-mv` split looks exactly like this.
    const ownedBy = n.attrs.ownedBy;
    if (typeof ownedBy === "string") {
      const member = memberOfEstate.get(ownedBy);
      const address = n.id.slice(n.id.indexOf("/") + 1);
      const target = member ? `${member}/${address}` : undefined;
      if (target && target !== n.id && byId.has(target)) link(n.id, target, "owned-by");
    }
    const producer = n.attrs.producer as { estate?: unknown; address?: unknown } | undefined;
    if (!isRecord(producer) || typeof producer.estate !== "string") continue;
    const member = memberOfEstate.get(producer.estate);
    const target = member && typeof producer.address === "string" ? `${member}/${producer.address}` : undefined;
    if (target && byId.has(target)) {
      n.attrs = { ...n.attrs, reads: target };
      link(n.id, target, "tofu-estate");
      continue;
    }
    n.attrs = {
      ...n.attrs,
      unresolved: member
        ? typeof producer.address === "string"
          ? `${producer.address} is not declared by the ${member} member`
          : `reads the ${member} member's estate as a whole (no tag:tofu-address filter)`
        : `estate "${producer.estate}" is not a member of this estate`,
    };
  }
  return ir;
}

/** The two fields a choudoufu card leads with (pinhole presentation pack,
 * registered in src/render.ts): the rung and the estate for an instance, the
 * producer for a data source. Without a pack the card would lead with the
 * first two short attrs alphabetically — `estate` then `rung` by accident
 * today, `reason` the day a refusal appears. */
export function choudoufuCardFields(node: { attrs: Record<string, unknown> }): Array<{ label: string; value: string }> | undefined {
  const a = node.attrs;
  const producer = a.producer as { estate?: unknown; address?: unknown } | undefined;
  if (isRecord(producer) && typeof producer.estate === "string") {
    return [{ label: "reads", value: typeof producer.address === "string" ? `${producer.estate} ${producer.address}` : producer.estate }];
  }
  if (typeof a.rung !== "string" && typeof a.estate !== "string") return undefined;
  return [
    ...(typeof a.rung === "string" ? [{ label: "rung", value: a.rung }] : []),
    ...(typeof a.estate === "string" ? [{ label: "estate", value: a.estate }] : []),
  ];
}

// ---------------------------------------------------------------------------
// The binary.
// ---------------------------------------------------------------------------

/**
 * The choudoufu behold spawns (#388, decision 4 of #386): `CHOUDOUFU_BIN` when
 * it names one, else `choudoufu` from PATH. One helper, so the version probe,
 * the doctor line, every `-json` read and the demo requirement check all mean
 * the same binary.
 *
 * It exists because the Homebrew release is 0.15.0, below behold's floor, and
 * the build that carries the floor's fields is one somebody built from main
 * and left outside PATH. Read on every call, not captured: a served-project
 * switch or a test may change it under a running process. Workbench scripts
 * spell the same fallback, `${CHOUDOUFU_BIN:-choudoufu}`.
 */
export function choudoufuBinary(): string {
  return process.env.CHOUDOUFU_BIN || "choudoufu";
}

/** What `choudoufu version -json` said. `forkField` is whether the document
 * carried `choudoufu_version` at all — absent means v0.15.0 or older
 * (choudoufu#968 designed the key to be always present, empty on a dev build,
 * so that absence means "too old" and nothing else). */
export interface ChoudoufuVersion {
  bin: string;
  /** The release tag, or `""` on a development build. */
  version: string;
  forkField: boolean;
  /** The upstream OpenTofu base, for the doctor line. */
  upstream?: string;
}

/** Parse `version -json`'s stdout. Exported for testing. */
export function parseChoudoufuVersion(stdout: string, bin: string = choudoufuBinary()): ChoudoufuVersion | undefined {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(json)) return undefined;
  const forkField = "choudoufu_version" in json;
  return {
    bin,
    version: typeof json.choudoufu_version === "string" ? json.choudoufu_version : "",
    forkField,
    ...(typeof json.terraform_version === "string" ? { upstream: json.terraform_version } : {}),
  };
}

/** A git-describe build (`v0.15.0-30-g9c7d…`) is past its base tag by
 * construction; a build from main after the fields landed is accepted at the
 * floor even though its base tag is below it. */
export function isDevBuild(version: string): boolean {
  return /-\d+-g[0-9a-f]+$/.test(version) || version === "";
}

/** Does this choudoufu meet the floor? The field's presence is the real check
 * (a document without `choudoufu_version` is older than every field this
 * member reads); the number only refuses a RELEASE below the floor. */
export function choudoufuMeetsFloor(v: ChoudoufuVersion): boolean {
  if (!v.forkField) return false;
  return isDevBuild(v.version) || meetsFloor(v.version, CHOUDOUFU_FLOOR);
}

const versionCache = new Map<string, ChoudoufuVersion | undefined>();

/** The choudoufu `choudoufuBinary()` names, once per binary per process:
 * undefined when there is none. Sync because it is the version half of
 * `memberIr`'s cache key, which is computed on every read. */
export function choudoufuVersion(bin: string = choudoufuBinary()): ChoudoufuVersion | undefined {
  if (versionCache.has(bin)) return versionCache.get(bin);
  const run = spawnSync(bin, ["version", "-json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const v = run.error || run.status !== 0 ? undefined : parseChoudoufuVersion(run.stdout, bin);
  versionCache.set(bin, v);
  return v;
}

/** Forget the cached version — for tests, and for a server whose PATH changed. */
export function resetChoudoufuVersionCache(): void {
  versionCache.clear();
}

/** #372: the environment a demo hands its choudoufu spawns — the scratch
 * emulator's endpoint and the dummy credentials it accepts — kept here rather
 * than written into `process.env`, so a served project switch can drop it and
 * nothing else in the process inherits it. Undefined outside a demo. */
let spawnEnvOverride: Record<string, string> | undefined;

export function setChoudoufuSpawnEnv(env: Record<string, string> | undefined): void {
  spawnEnvOverride = env && Object.keys(env).length ? { ...env } : undefined;
}

/** The environment a choudoufu spawn gets: the process's, the demo override
 * on top, colour off. Exported for testing. */
export function choudoufuSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...(spawnEnvOverride ?? {}), NO_COLOR: "1" };
}

/** Spawn choudoufu and capture both streams whole. Raw `Buffer` chunks decoded
 * once at close, as `runChantRaw` does — coercing per chunk corrupts a
 * multi-byte character straddling the 64KB highWaterMark. Never rejects: a
 * missing binary is code 127, a failing exit is data. */
export function captureChoudoufu(args: string[], cwd: string, bin: string = choudoufuBinary()): Promise<Captured> {
  return new Promise((resolvePromise) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let proc;
    try {
      proc = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: choudoufuSpawnEnv() });
    } catch (e) {
      resolvePromise({ code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
      return;
    }
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => err.push(c));
    proc.on("error", (e) => resolvePromise({ code: 127, stdout: "", stderr: e.message }));
    proc.on("close", (code) => resolvePromise({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

/** `choudoufu live-check -json .` in `dir`, as a document or a refusal. The
 * spawn is injectable so the parse and the IR are testable off recorded
 * documents without a binary. */
export async function readLiveCheck(dir: string, run: (args: string[], cwd: string) => Promise<Captured> = captureChoudoufu): Promise<LiveCheckParse> {
  return parseLiveCheckOutput(await run(["live-check", "-json", "."], dir), dir);
}

/** A refusal, thrown where a read cannot answer. `firstLine` in src/estate.ts
 * reads the part after "exited N: ", so the message is shaped that way. */
export class ChoudoufuReadError extends Error {
  constructor(readonly refusal: ChoudoufuRefusal, dir: string) {
    super(`choudoufu live-check ${dir} exited 1: ${refusal.error}`);
  }
}

// The kind's `via` and spec live in src/choudoufu-live.ts (#370), which owns
// the live half and imports this module for the declared one.

/**
 * The module INSTANCE an address sits in, or undefined when it sits in the
 * root module (#393 B).
 *
 * `module.team_pod["pod-a"].aws_iam_role.pod_role[2]` →
 * `module.team_pod["pod-a"]`. The instance, not the module: a terralith calls
 * one module twice and the two copies are two boxes, which is the grouping a
 * person reads the estate by — the `["pod-a"]` is the whole point. A nested
 * call keeps only its OUTERMOST instance, so the estate groups by the thing
 * its own root declares rather than by a depth nobody chose.
 *
 * Deliberately not a grouping by TYPE: an estate of 248 identity resources
 * would draw as one box called `aws_iam_role` and say nothing a card does not.
 */
export function moduleInstanceOf(address: string): string | undefined {
  const m = /^module\.[A-Za-z0-9_-]+(\[[^\]]*\])?/.exec(address);
  return m ? m[0] : undefined;
}
