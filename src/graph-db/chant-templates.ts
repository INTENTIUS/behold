/**
 * behold#1027 follow-up: the investigation templates from chant's catalog
 * (INTENTIUS/chant#4531, behold#1022 ruling Q5), when the chant beside behold
 * ships them.
 *
 * chant carries the templates as data, `@intentius/chant/capabilities/templates.json`,
 * the same set as the `templates` field of its capabilities document, from
 * `CAPABILITY_TEMPLATES_FLOOR` (chant's NEXT_RELEASE, which
 * `CHANT_RELEASE.version` names). The published chant behold depends on while
 * `CHANT_RELEASE.released` is false has no such export, so the file is looked
 * for at run time under a specifier the type checker and the bundler leave
 * alone. It is JSON, so the bundled dist/cli.js under plain node loads it too.
 * A chant without it, or a file that does not hold to version 1 of the shape,
 * gives undefined, and src/graph-db/templates.ts keeps its bundled stub.
 *
 * Once the switch says released, every chant behold accepts has the file, and
 * the stub in templates.ts is dead code to delete with this fallback.
 */
import type { Template } from "./templates.ts";

// TODO(behold#1027, chant#4531): a copy of chant's `TemplateEntry`
// (packages/core/src/capabilities/templates.ts). chant exports the data, not
// the module, and no published chant has either, so the type cannot be
// imported yet. Re-export chant's type when `CHANT_RELEASE.released` flips
// and chant exports its templates module.
export type ChantTemplateQueryKind = "path" | "cypher";
export type ChantTemplateReads = "source" | "live" | "snapshots" | "session";
export type ChantTemplateInputKind = "resource" | "scope" | "term";

export interface ChantTemplateInput {
  name: string;
  kind: ChantTemplateInputKind;
  description: string;
}

export interface ChantTemplateEntry {
  id: string;
  title: string;
  question: string;
  sources?: string[];
  inputs: ChantTemplateInput[];
  reads: ChantTemplateReads;
  query: { kind: ChantTemplateQueryKind; text: string };
  note?: string;
}

/** The templates.json shape version behold reads (chant's TEMPLATES_DATA_VERSION). */
export const CHANT_TEMPLATES_DATA_VERSION = 1;

export const CHANT_TEMPLATES_SPECIFIER: string = "@intentius/chant/capabilities/templates.json";

const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const READS: readonly string[] = ["source", "live", "snapshots", "session"];

function isEntry(t: unknown): t is ChantTemplateEntry {
  const e = t as Partial<ChantTemplateEntry> | null;
  return (
    !!e &&
    str(e.id) &&
    str(e.title) &&
    READS.includes(e.reads as string) &&
    Array.isArray(e.inputs) &&
    e.inputs.every((i) => !!i && str(i.name) && str(i.description)) &&
    !!e.query &&
    (e.query.kind === "path" || e.query.kind === "cypher") &&
    str(e.query.text) &&
    (e.sources === undefined || (Array.isArray(e.sources) && e.sources.every(str)))
  );
}

/** chant's entry in behold's shape. The resource input is the node, filled from the resolved node, so it is not one of behold's inputs. */
export function fromChantEntry(e: ChantTemplateEntry): Template {
  return {
    name: e.id,
    title: e.title,
    ...(e.sources ? { sources: e.sources as Template["sources"] } : {}),
    inputs: e.inputs.filter((i) => i.kind !== "resource").map((i) => ({ name: i.name, description: i.description })),
    language: e.query.kind === "path" ? "search" : "cypher",
    query: e.query.text,
    reads: e.reads,
    ...(e.note ? { note: e.note } : {}),
  };
}

/** A templates.json document (or a capabilities document carrying `templates` as that file does) to behold's templates, or undefined when it does not hold to the shape. */
export function templatesFromChant(raw: unknown): Template[] | undefined {
  const doc = (raw as { default?: unknown })?.default ?? raw;
  const d = doc as { version?: unknown; templates?: unknown } | null;
  if (!d || d.version !== CHANT_TEMPLATES_DATA_VERSION || !Array.isArray(d.templates) || d.templates.length === 0) return undefined;
  if (!d.templates.every(isEntry)) return undefined;
  return d.templates.map(fromChantEntry);
}

/** The installed chant's templates, or undefined when it has none. */
export async function loadChantTemplates(specifier: string = CHANT_TEMPLATES_SPECIFIER): Promise<Template[] | undefined> {
  return import(/* @vite-ignore */ specifier, { with: { type: "json" } }).then(templatesFromChant, () => undefined);
}
