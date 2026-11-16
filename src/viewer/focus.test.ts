import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphDocument } from "../graph-document.ts";
import { cutDocument } from "../graph-cut.ts";
import { focusCut, litCards } from "./focus.ts";

// The public INTENTIUS/behold-sandbox export: two roots, no edge between them,
// and a resource with `count` whose cards sit in the parent box.
const sandbox = JSON.parse(readFileSync(join(__dirname, "..", "..", "surfaces", "backstage-plugin-behold", "fixtures", "behold-sandbox.graph.json"), "utf8")) as GraphDocument;

const ids = (d: GraphDocument) => d.nodes.map((n) => n.id).sort();

describe("focusCut", () => {
  it("cuts around a bare root name, so only that root's cards are drawn", () => {
    const d = focusCut(sandbox, ["behold-sandbox/app"]);
    expect(d.cut.kind).toBe("around");
    expect(ids(d)).toEqual([
      "behold-sandbox/app/local_sensitive_file.db_credentials",
      "behold-sandbox/app/null_resource ×3",
      "behold-sandbox/app/random_password.db",
    ]);
    expect(d.groups.map((g) => g.id)).toEqual(["stack:behold-sandbox/app"]);
  });
  it("takes a box id and the same cut as the tab's", () => {
    const viaId = focusCut(sandbox, ["stack:behold-sandbox/app"]);
    const direct = cutDocument(sandbox, ["stack:behold-sandbox/app"], { depth: 1 });
    expect(direct.ok && viaId).toEqual(direct.ok && direct.document);
  });
  it("leaves out the cards of a counted resource, which sit in the parent box", () => {
    expect(ids(focusCut(sandbox, ["behold-sandbox/app"])).some((id) => id.includes("null_resource.service["))).toBe(false);
  });
  it("takes a card id and keeps its neighbour", () => {
    expect(ids(focusCut(sandbox, ["behold-sandbox/app/random_password.db"]))).toEqual([
      "behold-sandbox/app/local_sensitive_file.db_credentials",
      "behold-sandbox/app/random_password.db",
    ]);
  });
  it("draws the document as it is with no focus, an unknown name, or a document already cut", () => {
    expect(focusCut(sandbox, undefined)).toBe(sandbox);
    expect(focusCut(sandbox, ["ghost"])).toBe(sandbox);
    const cut = focusCut(sandbox, ["behold-sandbox/app"]);
    expect(focusCut(cut, ["behold-sandbox/core"])).toBe(cut);
  });
});

describe("litCards", () => {
  it("lights the asked-for card and dims nothing without one", () => {
    expect(litCards(sandbox, { node: "a" })).toEqual(new Set(["a"]));
    expect(litCards(sandbox, {})).toBeUndefined();
  });
});
