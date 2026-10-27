// behold#1027 follow-up: the templates come from chant's catalog (chant#4531). behold#1005 flipped the
// chant release, so there is no stub any more: chant's catalog or nothing.
import { investigationTemplates } from "@intentius/chant/capabilities/templates";
import { describe, expect, it } from "vitest";
import { chantTemplates, fromChantEntry, templatesFromChant } from "./chant-templates.ts";
import { TEMPLATES, TEMPLATE_CATALOG, selectTemplates } from "./templates.ts";

const chantDoc = { version: 1, templates: investigationTemplates() };
const ids = (ts: readonly { name: string }[]) => ts.map((t) => t.name);

// The set behold's pane and `behold mcp ask` were built against (chant#4531's initial set).
const EXPECTED = [
  "dependents",
  "dependencies",
  "paths-to-kind",
  "capability",
  "drift",
  "dependents-all",
  "dependencies-all",
  "ownership",
  "same-object",
  "readers",
  "history",
];

describe("chant's catalog", () => {
  it("TEMPLATES is chant's, in chant's order", () => {
    expect(TEMPLATE_CATALOG.source).toBe("chant");
    expect(ids(TEMPLATES)).toEqual(investigationTemplates().map((t) => t.id));
    expect(ids(TEMPLATES)).toEqual(expect.arrayContaining(EXPECTED));
    expect(chantTemplates()).toEqual(TEMPLATES);
  });

  it("the resource input is the node, not one of behold's inputs, and Cypher binds $key", () => {
    const t = fromChantEntry(investigationTemplates().find((e) => e.id === "paths-to-kind")!);
    expect(t.inputs.map((i) => i.name)).toEqual(["kind"]);
    expect(t.language).toBe("search");
    for (const c of TEMPLATES.filter((x) => x.language === "cypher")) expect(c.query).toContain("$key");
  });

  it("a document carried under default (a JSON module namespace) reads the same", () => {
    expect(templatesFromChant({ default: chantDoc })).toEqual(templatesFromChant(chantDoc));
    expect(templatesFromChant(chantDoc)).toEqual(TEMPLATES);
  });

  it("a file of another shape gives undefined", () => {
    expect(templatesFromChant({ version: 2, templates: chantDoc.templates })).toBeUndefined();
    expect(templatesFromChant({ version: 1, templates: [] })).toBeUndefined();
    expect(templatesFromChant({ version: 1, templates: [{ id: "x" }] })).toBeUndefined();
    expect(templatesFromChant(undefined)).toBeUndefined();
  });

  it("no catalog offers nothing, never a stub", () => {
    const catalog = selectTemplates(undefined);
    expect(catalog.source).toBe("missing");
    expect(catalog.templates).toEqual([]);
    expect(selectTemplates([]).source).toBe("missing");
  });
});
