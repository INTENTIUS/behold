/**
 * behold#1027 follow-up: the investigation templates from chant's catalog
 * (INTENTIUS/chant#4531, behold#1022 ruling Q5).
 *
 * chant carries the templates as data (packages/core/src/capabilities/templates.json),
 * the same set as the `templates` field of its capabilities document, read and
 * checked by `investigationTemplates()` in `@intentius/chant/capabilities/templates`.
 * Every chant behold accepts carries it (`CAPABILITY_TEMPLATES_FLOOR` is the
 * release src/chant-release.ts names, behold#1005), so it is a static import
 * that the bundle carries, and this module only turns chant's entries into
 * behold's {@link Template} shape.
 */
import {
  TEMPLATES_DATA_VERSION,
  TemplateCatalogError,
  investigationTemplates,
  parseTemplates,
  type TemplateEntry,
} from "@intentius/chant/capabilities/templates";
import type { Template } from "./templates.ts";

export type {
  TemplateEntry as ChantTemplateEntry,
  TemplateInput as ChantTemplateInput,
  TemplateInputKind as ChantTemplateInputKind,
  TemplateQueryKind as ChantTemplateQueryKind,
  TemplateReads as ChantTemplateReads,
} from "@intentius/chant/capabilities/templates";

/** The templates.json shape version behold reads (chant's TEMPLATES_DATA_VERSION). */
export const CHANT_TEMPLATES_DATA_VERSION = TEMPLATES_DATA_VERSION;

/** chant's entry in behold's shape. The resource input is the node, filled from the resolved node, so it is not one of behold's inputs. */
export function fromChantEntry(e: TemplateEntry): Template {
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

/**
 * A templates.json document (or a capabilities document carrying `templates`
 * as that file does) to behold's templates, checked by chant's own
 * `parseTemplates`. Undefined when it does not hold to the shape or is empty.
 */
export function templatesFromChant(raw: unknown): Template[] | undefined {
  const doc = (raw as { default?: unknown })?.default ?? raw;
  let entries: TemplateEntry[];
  try {
    entries = parseTemplates(doc);
  } catch (e) {
    if (e instanceof TemplateCatalogError) return undefined;
    throw e;
  }
  return entries.length ? entries.map(fromChantEntry) : undefined;
}

/** The installed chant's templates, in chant's order. */
export function chantTemplates(): Template[] {
  return investigationTemplates().map(fromChantEntry);
}
