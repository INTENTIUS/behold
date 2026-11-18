/**
 * behold#1027: resolve-from-resource and the investigation templates
 * (behold#1022's design, ruled 2026-10-26).
 *
 * Resolve takes one thing a person or an agent has (a name, an IR id, a block
 * address or a cloud id) and lands on one node, or on the list of candidates
 * when it is ambiguous. It reads the loaded rows in memory, so it works with
 * or without the LadybugDB peer.
 *
 * A template is a fixed query with the node filled in, so a click and an
 * agent run the same query and draw the same view. Each says which language
 * it expands to (ruling Q4 on #1022): a `chant search` path pattern where one
 * can express the question, which keeps working without the peer, and Cypher
 * otherwise. Cypher templates take the node and their inputs as query
 * parameters, never spliced into the text.
 *
 * The catalog lives in chant (#1022 ruling Q5,
 * https://github.com/INTENTIUS/behold/issues/1022#issuecomment-6432728696),
 * as the capability catalog's second kind of entry (INTENTIUS/chant#4531),
 * and behold reads it through src/graph-db/chant-templates.ts. Every chant
 * behold accepts carries it (behold#1005 flipped src/chant-release.ts), so
 * behold keeps no copy of it.
 *
 * behold#1142: a project adds its own templates in `.chant/templates.json`,
 * so the catalog belongs to the served project. The pane keeps one per
 * session ({@link catalogFor}, src/graph-db/pane.ts), and every reader takes
 * it as an argument. A project entry chant refuses, or one behold or the
 * engine cannot run, is listed under `refused` with the file and the field.
 */
import { CHANT_RELEASE } from "../chant-release.ts";
import { PROJECT_TEMPLATES_FILE, chantTemplates, projectCatalog } from "./chant-templates.ts";
import { engineRefusals, type RefusedTemplate, type Template, type TemplateCatalog } from "./template-rules.ts";

export * from "./template-rules.ts";

/** The templates found, or nothing when the installed chant somehow has none. */
export function selectTemplates(found: readonly Template[] | undefined, refused: readonly RefusedTemplate[] = []): TemplateCatalog {
  if (found?.length) {
    const own = found.filter((t) => t.origin === "project").length;
    const note = `chant's investigation templates (@intentius/chant/capabilities/templates, chant#4531)${own || refused.length ? `, and the project's own from ${PROJECT_TEMPLATES_FILE}` : ""}`;
    return { source: "chant", templates: found, refused, note };
  }
  return { source: "missing", templates: [], refused, note: `the installed chant has no investigation templates; chant ${CHANT_RELEASE.version} or later carries them` };
}

let chantOnly: TemplateCatalog | undefined;

/** chant's templates alone, as a project with no templates file has them. */
export function chantCatalog(): TemplateCatalog {
  chantOnly ??= selectTemplates(chantTemplates());
  return chantOnly;
}

/**
 * The catalog for the project at `dir`: chant's templates, then the
 * project's (chant's `templateCatalog(dir)`). behold reads one scope input,
 * as the env, so a project template with more than one is refused here.
 * The engine's check comes later, when the session's database opens
 * ({@link withEngineRefusals}).
 */
export function catalogFor(dir: string): TemplateCatalog {
  const p = projectCatalog(dir);
  const refused: RefusedTemplate[] = p.refused.map((r) => ({ ...r, by: "chant" }));
  const kept: Template[] = [];
  for (const t of p.templates) {
    const scopes = t.inputs.filter((i) => i.kind === "scope");
    if (t.origin === "project" && scopes.length > 1) {
      const field = p.fieldOf(t.name, ".inputs");
      refused.push({
        id: t.name,
        file: PROJECT_TEMPLATES_FILE,
        ...(field ? { field } : {}),
        message: `${PROJECT_TEMPLATES_FILE}${field ? ` ${field}` : ""}: template ${t.name}: behold reads one scope input, as the env, and this one has ${scopes.length} (${scopes.map((i) => i.name).join(", ")})`,
        by: "behold",
      });
      continue;
    }
    kept.push(t);
  }
  return { ...selectTemplates(kept, refused), fieldOf: p.fieldOf };
}

/**
 * The catalog with the project's Cypher templates the engine refused moved
 * to `refused` (./template-rules.ts `engineRefusals`, with chant's name for
 * the project's templates file).
 */
export function withEngineRefusals(catalog: TemplateCatalog, check: (cypher: string) => Promise<string | undefined>): Promise<TemplateCatalog> {
  return engineRefusals(catalog, check, PROJECT_TEMPLATES_FILE);
}
