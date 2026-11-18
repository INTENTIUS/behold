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
 *
 * behold#1142: a project adds its own in `.chant/templates.json`, which
 * chant's `templateCatalog(dir)` reads beside chant's (chant
 * `PROJECT_TEMPLATES_FLOOR`, the release src/chant-release.ts names). It
 * checks the shape and refuses a bad or colliding entry alone, naming the
 * file and the field; {@link projectCatalog} carries both lists over.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_TEMPLATES_FILE,
  TEMPLATES_DATA_VERSION,
  TemplateCatalogError,
  investigationTemplates,
  parseTemplates,
  templateCatalog,
  templatesRoot,
  type CatalogTemplate,
  type RefusedTemplate,
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
export function fromChantEntry(e: TemplateEntry, origin: CatalogTemplate["origin"] = "chant"): Template {
  return {
    name: e.id,
    title: e.title,
    origin,
    ...(e.sources ? { sources: e.sources as Template["sources"] } : {}),
    ...(e.kinds ? { kinds: e.kinds } : {}),
    inputs: e.inputs.filter((i) => i.kind !== "resource").map((i) => ({ name: i.name, kind: i.kind as "scope" | "term", description: i.description })),
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
  return entries.length ? entries.map((e) => fromChantEntry(e)) : undefined;
}

/** The installed chant's templates, in chant's order. */
export function chantTemplates(): Template[] {
  return investigationTemplates().map((e) => fromChantEntry(e));
}

/** The project templates file's entries by id, to name a refused entry's field. Empty when it cannot be read. */
function entryIndex(dir: string): Map<string, number> {
  try {
    const raw = JSON.parse(readFileSync(join(templatesRoot(dir), PROJECT_TEMPLATES_FILE), "utf8")) as { templates?: unknown };
    const list = Array.isArray(raw.templates) ? (raw.templates as Array<{ id?: unknown }>) : [];
    return new Map(list.flatMap((t, i) => (typeof t?.id === "string" ? [[t.id, i] as const] : [])));
  } catch {
    return new Map();
  }
}

/**
 * chant's templates and the project's own, for the project at `dir`, through
 * chant's `templateCatalog(dir)`: the templates in behold's shape, each with
 * its origin, and the project entries chant refused. `fieldOf(id, rest)`
 * names a loaded project entry's field (`templates[2].query.text`), for a
 * refusal behold adds after chant's.
 */
export function projectCatalog(dir: string): { templates: Template[]; refused: RefusedTemplate[]; fieldOf: (id: string, rest: string) => string | undefined } {
  const c = templateCatalog(dir);
  const index = c.templates.some((t) => t.origin === "project") ? entryIndex(dir) : new Map<string, number>();
  return {
    templates: c.templates.map((t) => fromChantEntry(t, t.origin)),
    refused: c.refused,
    fieldOf: (id, rest) => (index.has(id) ? `templates[${index.get(id)}]${rest}` : undefined),
  };
}

export { PROJECT_TEMPLATES_FILE, type RefusedTemplate };
