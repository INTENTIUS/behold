import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { detectProject } from "./project.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpProject(config: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-project-"));
  if (config !== null) writeFileSync(join(dir, "chant.config.ts"), config);
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

  it("reads declared environments and lexicons from a literal config", async () => {
    const dir = make(
      `export default { lexicons: ["aws", "k8s"], environments: ["prod", "staging"], sourceDir: "src" };`,
    );
    expect(await detectProject(dir)).toEqual({ environments: ["prod", "staging"], lexicons: ["aws", "k8s"] });
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
});
