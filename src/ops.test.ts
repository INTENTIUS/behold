import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { discoverOps } from "./ops.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "behold-ops-"));
  mkdirSync(join(dir, "ops"));
  writeFileSync(
    join(dir, "ops", "apply.op.ts"),
    `import { ApplyOp } from "@intentius/chant-lexicon-temporal";\nconst { op } = ApplyOp({ name: "prod-apply", env: "prod", target: "cloudformation", gate: { signalName: "approve-prod-apply" } });\nexport default op;\n`,
  );
  writeFileSync(
    join(dir, "ops", "reconcile.op.ts"),
    `import { ReconcileOp } from "@intentius/chant-lexicon-temporal";\nconst { op } = ReconcileOp({ name: "prod-reconcile", env: "prod", onDrift: "pull-request" });\nexport default op;\n`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("discoverOps", () => {
  it("finds Ops by declared name and classifies apply/reconcile + gate", () => {
    const ops = discoverOps(dir);
    expect(ops.map((o) => o.name)).toEqual(["prod-apply", "prod-reconcile"]); // sorted
    const apply = ops.find((o) => o.name === "prod-apply")!;
    expect(apply.kind).toBe("apply");
    expect(apply.gate).toBe("approve-prod-apply");
    expect(ops.find((o) => o.name === "prod-reconcile")!.kind).toBe("reconcile");
  });

  it("returns [] for a project with no ops", () => {
    const empty = mkdtempSync(join(tmpdir(), "behold-noops-"));
    expect(discoverOps(empty)).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});
