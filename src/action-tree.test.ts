import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("the action's root layout (#1063)", () => {
  it("holds one action.yml at the root and every path it runs exists", () => {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "action-tree.mjs")], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("one action.yml at the root");
  });
  it("keeps the description under the Marketplace's 125 characters", async () => {
    const { readFileSync } = await import("node:fs");
    const yml = readFileSync(join(import.meta.dirname, "..", "action.yml"), "utf8");
    const description = /^description:\s*(.*)$/m.exec(yml)?.[1]?.trim() ?? "";
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThan(125);
  });
});
