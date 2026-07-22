import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { detectProject, loadBeholdConfig } from "./project.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function tmpProject(config: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-project-"));
  if (config !== null) writeFileSync(join(dir, "chant.config.ts"), config);
  return dir;
}

/** A tmp project root with (or without) a `.behold.json` — #70's tier config,
 * kept separate from `chant.config.ts` (tmpProject, above). `raw`, when given,
 * is written as-is, so a test can also cover malformed JSON / a malformed
 * `tiers` shape, not just the happy path. */
function tmpBeholdConfig(raw: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-config-"));
  if (raw !== null) writeFileSync(join(dir, ".behold.json"), raw);
  return dir;
}

describe("detectProject", () => {
  let dirs: string[] = [];
  beforeAll(() => (dirs = []));
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const make = (config: string | null) => {
    const d = tmpProject(config);
    dirs.push(d);
    return d;
  };

  it("reads declared environments, lexicons, and sourceDir from a literal config", async () => {
    const dir = make(
      `export default { lexicons: ["aws", "k8s"], environments: ["prod", "staging"], sourceDir: "src" };`,
    );
    expect(await detectProject(dir)).toEqual({
      environments: ["prod", "staging"],
      lexicons: ["aws", "k8s"],
      sourceDir: "src",
    });
  });

  // #71: graphPath() honors a non-`src/` sourceDir — this locks in that
  // detectProject surfaces it (any legal directory name, not just "src").
  it("reads a non-src sourceDir from a literal config", async () => {
    const dir = make(`export default { lexicons: ["aws"], sourceDir: "infra" };`);
    expect((await detectProject(dir)).sourceDir).toBe("infra");
  });

  it("reads stacks[] from a literal config", async () => {
    const dir = make(
      `export default { lexicons: ["aws"], stacks: [{ name: "api", src: "stacks/api" }, { name: "web", src: "stacks/web" }] };`,
    );
    expect((await detectProject(dir)).stacks).toEqual([
      { name: "api", src: "stacks/api" },
      { name: "web", src: "stacks/web" },
    ]);
  });

  it("falls back to a text-parsed sourceDir when the config can't be imported (e.g. a missing dep)", async () => {
    const dir = make(
      `import "a-package-that-does-not-exist";\nexport default { lexicons: ["aws"], sourceDir: "infra" };`,
    );
    expect((await detectProject(dir)).sourceDir).toBe("infra");
  });

  it("handles multiline / single-quoted arrays", async () => {
    const dir = make(`export default {\n  lexicons: ['aws'],\n  environments: [\n    'prod',\n    'dev',\n  ],\n};`);
    expect((await detectProject(dir)).environments).toEqual(["prod", "dev"]);
  });

  it("reads environments through a defineConfig-style wrapper / satisfies", async () => {
    // The text parser also catches this, but it proves the shape is handled.
    const dir = make(
      `const identity = (c) => c;\nexport default identity({ lexicons: ["gcp"], environments: ["prod"] });`,
    );
    expect((await detectProject(dir)).environments).toEqual(["prod"]);
  });

  it("returns empty arrays when a field is absent", async () => {
    const dir = make(`export default { lexicons: ["aws"] };`);
    expect(await detectProject(dir)).toEqual({ environments: [], lexicons: ["aws"] });
  });

  it("returns empty when the field is computed, not a literal array", async () => {
    const dir = make(`const envs = globalThis.__nope__ || []; export default { lexicons: ["aws"], environments: envs };`);
    expect((await detectProject(dir)).environments).toEqual([]);
  });

  it("returns empty for a project with no config", async () => {
    expect(await detectProject(make(null))).toEqual({ environments: [], lexicons: [] });
  });

  // The committed fixture (e2e/fixtures/multi-stack, #76) — a real, durable
  // two-stack project on disk, distinct from the inline temp-dir configs above.
  it("reads both stacks from the committed e2e/fixtures/multi-stack fixture", async () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "e2e", "fixtures", "multi-stack");
    const info = await detectProject(fixture);
    expect(info.stacks).toEqual([
      { name: "api", src: "stacks/api" },
      { name: "web", src: "stacks/web" },
    ]);
  });
});

// #70: tiers are a separate, behold-owned `.behold.json` in the project root
// — not `chant.config.ts` — so a chant project that never opts in gets no
// tier axis at all (no picker, graph loads with no tier selected).
describe("loadBeholdConfig", () => {
  let dirs: string[] = [];
  beforeAll(() => (dirs = []));
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const make = (raw: string | null) => {
    const d = tmpBeholdConfig(raw);
    dirs.push(d);
    return d;
  };

  it("reads the pinned schema — envVar + values", () => {
    const dir = make(
      JSON.stringify({ tiers: { envVar: "LOOM_TIER", values: ["light", "production", "production-ha"] } }),
    );
    expect(loadBeholdConfig(dir)).toEqual({
      tiers: { envVar: "LOOM_TIER", values: ["light", "production", "production-ha"] },
    });
  });

  it("returns {} — no tier axis — when the file is absent", () => {
    expect(loadBeholdConfig(make(null))).toEqual({});
  });

  it("returns {} when the file has no tiers key", () => {
    expect(loadBeholdConfig(make(JSON.stringify({})))).toEqual({});
  });

  it("returns {} for unparseable JSON — never throws", () => {
    expect(loadBeholdConfig(make("{ not valid json"))).toEqual({});
  });

  it("returns {} when envVar is missing or not a string", () => {
    expect(loadBeholdConfig(make(JSON.stringify({ tiers: { values: ["light"] } })))).toEqual({});
    expect(loadBeholdConfig(make(JSON.stringify({ tiers: { envVar: 7, values: ["light"] } })))).toEqual({});
  });

  it("returns {} when values is missing, empty, or not an array", () => {
    expect(loadBeholdConfig(make(JSON.stringify({ tiers: { envVar: "LOOM_TIER" } })))).toEqual({});
    expect(loadBeholdConfig(make(JSON.stringify({ tiers: { envVar: "LOOM_TIER", values: [] } })))).toEqual({});
    expect(loadBeholdConfig(make(JSON.stringify({ tiers: { envVar: "LOOM_TIER", values: "light" } })))).toEqual({});
  });

  it("drops non-string entries from values, keeping the rest", () => {
    const dir = make(JSON.stringify({ tiers: { envVar: "LOOM_TIER", values: ["light", 7, "production"] } }));
    expect(loadBeholdConfig(dir)).toEqual({ tiers: { envVar: "LOOM_TIER", values: ["light", "production"] } });
  });
});
