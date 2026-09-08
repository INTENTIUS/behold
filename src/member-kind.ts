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
import { choudoufuSpec } from "./choudoufu-member.ts";
import type { MemberVia } from "./member-ir.ts";
import { chantConfigPath } from "./project.ts";

/** The vocabulary `.behold.json` may use. Closed on purpose: a kind is a
 * contract behold knows how to read, not a label a project invents. */
export const MEMBER_KINDS = ["chant", "choudoufu"] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];

export function isMemberKind(s: unknown): s is MemberKind {
  return typeof s === "string" && (MEMBER_KINDS as readonly string[]).includes(s);
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
