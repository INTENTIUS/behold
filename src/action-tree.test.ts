import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("the behold-action tree (#1063)", () => {
  it("builds complete and self-contained from action/", () => {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "action-tree.mjs"), "--check"], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("complete and self-contained");
  });
});
