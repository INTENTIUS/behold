/**
 * Estate member kinds (#368, the prerequisite for #366's choudoufu member).
 *
 * An estate member used to be a bare directory, and every member was assumed
 * to be a chant project: `detectProjectShape` kept only directories with a
 * `chant.config.*`, `composeEstate` shelled that member's own chant, and the
 * member IR cache keyed on the chant that would answer. A member that is not a
 * chant project vanished before any of that ran, with no report anywhere.
 *
 * This module is the one table that says what a member can be. A kind is:
 *
 *  - a `probe` — does this directory look like one (sync, read-only, no code
 *    run; the chant probe is `chantConfigPath`, the same test it always was);
 *  - a `via` — how it is read: a `tool` stamp (what answers reads for the
 *    member, as the version half of `memberIr`'s cache key) and the one
 *    uncached `read` that turns the member into a `GraphIR`, source or live
 *    per `opts`. The chant kind declares none: chant is the default reader
 *    (`chantVia`, src/member-ir.ts), and the estate supplies it.
 *
 * `composeEstate`, `composeEstateOverlay` and `estateNamespaceScopes` dispatch
 * through `memberKindOf(dir)`; `.behold.json` may name a kind explicitly
 * (`{ "dir": "x", "kind": "chant" }`) and a bare string is `chant`, so every
 * existing file keeps meaning what it meant. A kind nothing registered is
 * fail-closed: kept as an invalid declaration `behold doctor` reports, never
 * silently read as chant.
 *
 * This module imports nothing from the read path (src/chant.ts, src/member-ir.ts)
 * at runtime, on purpose: src/chant.ts imports src/project.ts, which imports
 * this, and a runtime edge back into chant.ts from here would be a cycle that
 * loads the real chant module underneath a test's mock of it.
 *
 * Adding a kind is one `registerMemberKind` call (see AGENTS.md, "Adding a
 * member kind"): the probe and the via, plus a presentation pack in
 * src/render.ts and a doctor line if the kind needs a tool on PATH.
 */
import type { GraphIR } from "@intentius/chant";
import { choudoufuSpec } from "./choudoufu-live.ts";
import type { MemberVia } from "./member-ir.ts";
import { chantConfigPath } from "./project.ts";
import { terraformSpec } from "./terraform-member.ts";

/** The vocabulary `.behold.json` may use. Closed on purpose: a kind is a
 * contract behold knows how to read, not a label a project invents. */
export const MEMBER_KINDS = ["chant", "choudoufu", "terraform"] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];

export function isMemberKind(s: unknown): s is MemberKind {
  return typeof s === "string" && (MEMBER_KINDS as readonly string[]).includes(s);
}

/** What a render pass is told about the request it is running for. */
export interface MemberPassOpts {
  /** The zoom the request asked for. `undefined` is chant's own default. */
  detail: number | undefined;
}

/** The two forms of the line a rendered graph carries about itself. */
export interface MemberPassNote {
  note?: string;
  noteShort?: string;
}

/**
 * What one kind's passes left behind, so a route can explain the picture
 * without knowing which kind drew it. The kind closes over its own result.
 *
 * `note` is separate from `apply` on purpose. The note is membership-driven —
 * a served Terraform member says which roots it found even when the zoom
 * elided nothing — while `apply` is content-driven, and resolving membership
 * costs a filesystem walk (`hasTerraformRoots`) that the three `/api/overlay`
 * sites do not pay today and must not start paying.
 */
export interface MemberPassOutcome {
  /** This kind's clause. `dirs` are the SERVED directories OF THIS KIND, in
   * composition order, and empty when none is served. */
  note(dirs: readonly string[]): MemberPassNote;
}

/** What a kind runs over an IR at render time, after the read. */
export interface MemberPasses {
  /**
   * Run over `ir`, IN PLACE — the existing passes mutate and their callers
   * depend on it. MUST be self-guarded on the IR's own content: an IR carrying
   * none of this kind's nodes comes back the identical object, untouched, so
   * every other estate renders byte-identical.
   */
  apply(ir: GraphIR, opts: MemberPassOpts): MemberPassOutcome;
}

/** What behold knows how to do with one kind of member. */
export interface MemberKindSpec {
  kind: MemberKind;
  /** Does `dir` look like a member of this kind? Sync and read-only. */
  probe(dir: string): boolean;
  /** What the probe looks for, for the message when a declared member fails
   * it: "a chant.config.* file". */
  expects: string;
  /** How a member of this kind is read. Absent only for chant, the default
   * reader every other kind is an alternative to. */
  via?: MemberVia;
  /** What this kind runs over an IR at RENDER time (#427). Absent for a kind
   * that contributes nothing, which is chant and choudoufu today. */
  passes?: MemberPasses;
}

const registry = new Map<MemberKind, MemberKindSpec>();

/** Register (or replace — tests register fakes) the spec for a kind. */
export function registerMemberKind(spec: MemberKindSpec): void {
  registry.set(spec.kind, spec);
}

/** The kinds this behold can actually read, in registration order. The
 * vocabulary (`MEMBER_KINDS`) can name a kind before a build registers it —
 * that is the "declared but this behold has no reader for it" case doctor
 * reports, and it is distinct from a word nobody knows. */
export function registeredMemberKinds(): MemberKind[] {
  return [...registry.keys()];
}

export function memberKindSpec(kind: MemberKind): MemberKindSpec | undefined {
  return registry.get(kind);
}

/** The first registered kind whose probe accepts `dir`, or undefined when no
 * registered kind does. Chant is registered first, so a directory that is a
 * chant project is a chant member whatever else it holds — the same priority
 * `detectProjectShape` gives a `chant.config.*` over a member list. */
export function memberKindOf(dir: string): MemberKind | undefined {
  for (const spec of registry.values()) if (spec.probe(dir)) return spec.kind;
  return undefined;
}

/** One request's passes, per kind, in registration order. */
export type MemberPassRun = ReadonlyArray<{ kind: MemberKind; outcome: MemberPassOutcome }>;

/**
 * Run every registered kind's render passes over `ir` (#427).
 *
 * The estate routes used to invoke one kind's passes by name at six sites, which
 * is the per-kind route fork AGENTS.md forbids. This is the one call they make
 * instead, and a kind that registers `passes` reaches every branch for free.
 *
 * Dispatch is over the IR's CONTENT, not over the served members' kinds. Each
 * kind's `apply` self-guards, and the deciding case is a chant project that
 * declares the terraform lexicon: its `memberKindOf` is `chant`, so membership
 * dispatch would silently stop rendering it (src/terraform-route.test.ts's
 * first block is exactly that estate). Membership decides only whose note it
 * is, in {@link memberPassNote}.
 *
 * Run the result through `memberPassNote` ONCE per response, and carry a run
 * forward rather than re-running: a pass that already elided its cards returns
 * an empty elision the second time, so a re-run silently drops the note.
 */
export function applyMemberPasses(ir: GraphIR, opts: MemberPassOpts): MemberPassRun {
  const run: { kind: MemberKind; outcome: MemberPassOutcome }[] = [];
  for (const spec of registry.values()) {
    if (!spec.passes) continue;
    run.push({ kind: spec.kind, outcome: spec.passes.apply(ir, opts) });
  }
  return run;
}

/**
 * The line a run contributes for these served directories.
 *
 * Each kind is handed only the dirs that are its own, so a kind never learns
 * about another's members and a route never names a kind. Joins are the ones
 * the Terraform note has always used — `"; "` long, `" · "` short — and a short
 * form identical to the long one is dropped rather than repeated.
 */
export function memberPassNote(run: MemberPassRun, dirs: readonly string[]): MemberPassNote {
  const kindOf = new Map(dirs.map((d) => [d, memberKindOf(d)]));
  const notes: string[] = [];
  const shorts: string[] = [];
  for (const { kind, outcome } of run) {
    const mine = dirs.filter((d) => kindOf.get(d) === kind);
    const { note, noteShort } = outcome.note(mine);
    if (note) notes.push(note);
    if (noteShort) shorts.push(noteShort);
  }
  const note = notes.join("; ");
  const noteShort = shorts.join(" · ");
  return note ? { note, ...(noteShort && noteShort !== note ? { noteShort } : {}) } : {};
}

/**
 * Does serving these directories go through the estate compose path (#389)?
 *
 * More than one always did. ONE does too when the directory is a member of a
 * kind that is not chant: the single-project read is `chant graph <dir>`, and a
 * lone choudoufu estate has no chant.config.ts and no lexicon, so that read
 * answers "No lexicon detected in infrastructure files" and behold serves the
 * no-project card over a perfectly good estate. src/project.ts already says
 * `behold serve <a choudoufu estate>` is a thing behold accepts; this is what
 * makes it true, and the workbench's generated single-estate entries (#389 —
 * every estate-gen cohort, every terralith) are what found it missing.
 *
 * A one-member estate composes exactly as a four-member one does, ids
 * namespaced under the member's short name, so the graph, the pane and the
 * morph agree on what a node is called.
 */
export function servesAsEstate(dirs: readonly string[]): boolean {
  if (dirs.length > 1) return true;
  return dirs.length === 1 && (memberKindOf(dirs[0]) ?? "chant") !== "chant";
}

/** The chant member: what every member was until #368. No `via`: chant is
 * the reader the estate falls back to, for this kind and for a directory no
 * kind claims. */
registerMemberKind({
  kind: "chant",
  probe: (dir) => !!chantConfigPath(dir),
  expects: "a chant.config.* file",
});

/** The choudoufu member (#369): an OpenTofu-fork estate whose ownership is
 * two AWS tags, read through `live-check -json`. After chant, so a directory
 * that is both is a chant member. */
registerMemberKind(choudoufuSpec);

/** The terraform member (#384): a directory of `.tf` files, read through a
 * `chant.config.ts` behold generates in a scratch directory of its own. After
 * choudoufu, so an estate whose roots carry a `live { … }` block is read as
 * the choudoufu estate it is — the tag-owned reading is the richer one, and
 * both would otherwise probe true. */
registerMemberKind(terraformSpec);
