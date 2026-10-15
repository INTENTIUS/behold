import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { demoProblem, readDemo } from "./terragucci-demo.ts";
import type { TerragucciSource } from "./terragucci-source.ts";

const FIXTURES = join(import.meta.dirname, "__fixtures__", "terragucci-demo");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;
const source = (doc: unknown): TerragucciSource => ({ kind: "dir", location: "fx", read: async () => JSON.stringify(doc) });
const about = { changes: "Network's port goes from 8080 to 9090.", watch: "Wave 2 fails partway.", shows: "Nothing here is atomic." };

describe("demo.json's about (behold#571)", () => {
  it("passes the scenario's card through", async () => {
    const a = await readDemo(source({ ...fixture("demo-failed.json"), about }));
    expect("demo" in a && a.demo && a.demo.about).toEqual(about);
  });

  it("reads a demo.json without about, or with null, as no card", async () => {
    for (const doc of [fixture("demo-failed.json"), { ...fixture("demo-reset.json"), about: null }]) {
      const a = await readDemo(source(doc));
      expect(a.demo).not.toBeNull();
      expect(a.demo!.about).toBeNull();
    }
  });

  it("keeps only the three fields", async () => {
    const a = await readDemo(source({ ...fixture("demo-failed.json"), about: { ...about, extra: "x" } }));
    expect(a.demo!.about).toEqual(about);
  });

  it("refuses an about that is not three non-empty strings", async () => {
    const base = fixture("demo-failed.json");
    expect(demoProblem({ ...base, about: "text" })).toMatch(/about is neither an object nor null/);
    expect(demoProblem({ ...base, about: [] })).toMatch(/about is neither an object nor null/);
    expect(demoProblem({ ...base, about: { ...about, watch: 3 } })).toMatch(/about\.watch/);
    expect(demoProblem({ ...base, about: { changes: about.changes, watch: about.watch } })).toMatch(/about\.shows/);
    expect(demoProblem({ ...base, about: { ...about, changes: "  " } })).toMatch(/about\.changes/);
    const a = await readDemo(source({ ...base, about: { ...about, shows: null } }));
    expect("error" in a && a.error).toMatch(/not the demo's format: about\.shows/);
  });
});

describe("demo.json's intro, name, scenarios and index (behold#571)", () => {
  const intro = "One change can touch many Terraform states, and this demo shows how terragucci applies them in order.";
  it("reads them when demo.json has them", async () => {
    const a = await readDemo(source({ ...fixture("demo-waiting.json"), intro: `  ${intro} `, name: "a new subnet", scenarios: 5, index: 2 }));
    expect(a.demo!.intro).toBe(intro);
    expect(a.demo!.name).toBe("a new subnet");
    expect(a.demo!.scenarios).toBe(5);
    expect(a.demo!.index).toBe(2);
  });
  it("reads a demo.json without them as null", async () => {
    const a = await readDemo(source(fixture("demo-waiting.json")));
    expect([a.demo!.intro, a.demo!.name, a.demo!.scenarios, a.demo!.index]).toEqual([null, null, null, null]);
  });
  it("reads the base's scenarios 0 and index null as none", async () => {
    const a = await readDemo(source({ ...fixture("demo-reset.json"), scenarios: 0, index: null, name: null }));
    expect([a.demo!.name, a.demo!.scenarios, a.demo!.index]).toEqual([null, null, null]);
  });
  it("leaves out one of the wrong type and keeps the narration", async () => {
    const a = await readDemo(source({ ...fixture("demo-waiting.json"), intro: "   ", name: 3, scenarios: "5", index: 0 }));
    expect(a.demo!.step).toBe("waiting");
    expect([a.demo!.intro, a.demo!.name, a.demo!.scenarios, a.demo!.index]).toEqual([null, null, null, null]);
  });
});
