import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { locationText, lockText, renderState, stateLegend, stateRowView, stateView } from "./state-locations.js";
import { stateLocationsFromDocument } from "../src/state-locations.ts";

// behold#1247: the words the State tab draws, for the answer /api/workspace/state gives on
// src/__fixtures__/state-locations/state-all.json (see src/state-locations.test.ts for the scene).
const doc = JSON.parse(readFileSync(join(import.meta.dirname, "..", "src", "__fixtures__", "state-locations", "state-all.json"), "utf8"));
const read = stateLocationsFromDocument(doc);
if (!read.ok) throw new Error(read.refusal.error);
const answer = { workspace: true, ...read.state };
const row = (member, unit) => stateRowView(answer.rows.find((r) => r.member === member && (unit === undefined || r.unit === unit)));

describe("locationText and lockText", () => {
  it("spell a location as key=value pairs and an unlocked state as not locked", () => {
    expect(locationText({ bucket: "b", key: "k" })).toBe("bucket=b key=k");
    expect(locationText({ path: null })).toBe("path=(none)");
    expect(lockText(null)).toBe("not locked");
    expect(lockText({ mechanism: "dynamodb", location: { table: "t" } })).toBe("dynamodb table=t");
  });
});

describe("stateLegend", () => {
  it("counts the locations and the unreachable ones, or names the refusal", () => {
    expect(stateLegend(answer).text).toBe("5 state locations in 2 members of 5 · every environment · 1 unreachable");
    expect(stateLegend({ ...answer, member: "platform", env: "prod", summary: { members: 1, published: 1, locations: 1, unreachable: 0 } }).text).toBe("1 state location in 1 member of 1 · member platform · environment prod");
    expect(stateLegend({ workspace: true, refusal: { error: "State locations needs chant 0.124.113 or newer.", remedy: "Upgrade." } })).toMatchObject({ tone: "refusal", text: "state locations not read: State locations needs chant 0.124.113 or newer." });
  });
});

describe("stateRowView", () => {
  it("draws a Terraform backend not checked, neutral, and an unreachable stack with chant's reason", () => {
    const tf = row("platform", "network");
    expect(tf.cells.slice(0, 8)).toEqual(["platform", "terraform", "dev", "network", "terraform s3", "bucket=acme-tfstate key=dev/network.tfstate region=us-east-1 access_key=***", "dynamodb table=acme-tflock", "not checked"]);
    expect(tf.reachTone).toBe("state-quiet");
    const cf = row("legacy", "billing");
    expect(cf.cells[7]).toBe("unreachable");
    expect(cf.reachTone).toBe("state-fail");
    expect(cf.reach).toMatch(/ExpiredToken/);
    expect(row("legacy", "orders").reachTone).toBe("state-ok");
  });

  it("gives a member with no location one note row, and no invented location", () => {
    const k = row("cluster");
    expect(k.note).toBe(true);
    expect(k.cells[6]).toBe("its lexicon publishes no state location");
    expect(k.cells[5]).toBe("");
    expect(row("broken").cells[6]).toBe("not read: terraform init was not run in the root");
  });
});

describe("renderState", () => {
  it("draws a table of a header and a row for each row, and the refusal alone when there is one", () => {
    const make = (tag) => ({ tag, className: "", textContent: "", children: [], dataset: {}, appendChild(c) { this.children.push(c); }, replaceChildren() { this.children = []; } });
    const saved = globalThis.document;
    globalThis.document = { createElement: make };
    try {
      const host = make("div");
      renderState(host, answer);
      const table = host.children.find((c) => c.tag === "table");
      expect(table.children).toHaveLength(1 + answer.rows.length);
      expect(table.children[0].children.map((c) => c.textContent)).toEqual(["member", "kind", "environment", "unit", "backend", "location", "lock", "reach"]);
      expect(table.children[1].dataset.member).toBe("cluster");
      const refused = make("div");
      renderState(refused, { workspace: true, refusal: { error: "too old" } });
      expect(refused.children).toHaveLength(1);
      expect(stateView({ error: "x" }).rows).toEqual([]);
    } finally {
      globalThis.document = saved;
    }
  });
});
