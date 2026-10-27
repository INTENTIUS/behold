// behold#1027 follow-up: the templates come from chant's catalog (chant#4531) when the installed chant has it, else behold's stub.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANT_TEMPLATES_SPECIFIER, fromChantEntry, loadChantTemplates, templatesFromChant, type ChantTemplateEntry } from "./chant-templates.ts";
import { STUB_TEMPLATES, selectTemplates } from "./templates.ts";

// A copy of chant's packages/core/src/capabilities/templates.json on integration/consolidation-graph (chant#4531).
const fixturePath = join(import.meta.dirname, "__fixtures__", "chant-templates.json");
const chantDoc = JSON.parse(readFileSync(fixturePath, "utf8")) as { version: number; templates: ChantTemplateEntry[] };
const ids = (ts: readonly { name: string }[]) => ts.map((t) => t.name);

describe("chant present", () => {
  it("chant's templates are used, in chant's order", () => {
    const fromChant = templatesFromChant(chantDoc)!;
    const catalog = selectTemplates(fromChant, false);
    expect(catalog.source).toBe("chant");
    expect(catalog.templates).toBe(fromChant);
    expect(ids(catalog.templates)).toEqual(chantDoc.templates.map((t) => t.id));
  });

  it("chant's set is the stub's: same ids, languages, queries, inputs and reads", () => {
    expect(templatesFromChant(chantDoc)).toEqual(STUB_TEMPLATES);
  });

  it("the resource input is the node, not one of behold's inputs, and Cypher binds $key", () => {
    const t = fromChantEntry(chantDoc.templates.find((e) => e.id === "paths-to-kind")!);
    expect(t.inputs.map((i) => i.name)).toEqual(["kind"]);
    expect(t.language).toBe("search");
    for (const c of templatesFromChant(chantDoc)!.filter((x) => x.language === "cypher")) expect(c.query).toContain("$key");
  });

  it("loads the file through the lazy import, as a JSON module", async () => {
    expect(ids((await loadChantTemplates(pathToFileURL(fixturePath).href))!)).toEqual(ids(STUB_TEMPLATES));
  });

  it("a document carried under default (a JSON module namespace) reads the same", () => {
    expect(templatesFromChant({ default: chantDoc })).toEqual(templatesFromChant(chantDoc));
  });
});

describe("chant absent", () => {
  it("the stub, with the same ids as chant's catalog", () => {
    const catalog = selectTemplates(undefined, false);
    expect(catalog.source).toBe("behold-stub");
    expect(catalog.templates).toBe(STUB_TEMPLATES);
    expect(ids(catalog.templates)).toEqual(chantDoc.templates.map((t) => t.id));
  });

  it("a chant without the export, or a file of another shape, gives undefined", async () => {
    expect(await loadChantTemplates("@intentius/chant/capabilities/no-such-file.json")).toBeUndefined();
    expect(templatesFromChant({ version: 2, templates: chantDoc.templates })).toBeUndefined();
    expect(templatesFromChant({ version: 1, templates: [] })).toBeUndefined();
    expect(templatesFromChant({ version: 1, templates: [{ id: "x" }] })).toBeUndefined();
    expect(templatesFromChant(undefined)).toBeUndefined();
  });

  it("once the chant release is out, the stub is not offered", () => {
    const catalog = selectTemplates(undefined, true);
    expect(catalog.source).toBe("missing");
    expect(catalog.templates).toEqual([]);
    expect(selectTemplates(templatesFromChant(chantDoc), true).source).toBe("chant");
  });
});

describe("the module's catalog", () => {
  afterEach(() => {
    vi.doUnmock(CHANT_TEMPLATES_SPECIFIER);
    vi.resetModules();
  });

  it("TEMPLATES is chant's when the installed chant ships the file", async () => {
    vi.resetModules();
    vi.doMock(CHANT_TEMPLATES_SPECIFIER, () => ({ default: chantDoc }));
    const m = await import("./templates.ts");
    expect(m.TEMPLATE_CATALOG.source).toBe("chant");
    expect(ids(m.TEMPLATES)).toEqual(chantDoc.templates.map((t) => t.id));
  });
});
