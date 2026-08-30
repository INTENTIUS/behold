import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { discoverOps, discoverEstateOps, discoverOpIrs, opIrPath } from "./ops.ts";
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

describe("discoverEstateOps (#31)", () => {
  it("finds Ops across all served projects, each tagged with its own dir", () => {
    const empty = mkdtempSync(join(tmpdir(), "behold-estate-empty-"));
    try {
      // primary (empty) first, the Ops project second — the estate still finds them.
      const ops = discoverEstateOps([empty, dir]);
      expect(ops.map((o) => o.name)).toEqual(["prod-apply", "prod-reconcile"]);
      expect(ops.every((o) => o.dir === dir)).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("keeps the first project's Op on a name collision across projects", () => {
    const other = mkdtempSync(join(tmpdir(), "behold-estate-dup-"));
    mkdirSync(join(other, "ops"));
    writeFileSync(
      join(other, "ops", "a.op.ts"),
      `import { ApplyOp } from "@intentius/chant-lexicon-temporal";\nconst { op } = ApplyOp({ name: "prod-apply", env: "staging", target: "kubectl" });\nexport default op;\n`,
    );
    try {
      const first = discoverEstateOps([dir, other]).find((o) => o.name === "prod-apply")!;
      expect(first.dir).toBe(dir); // the earlier project wins
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("discoverOps", () => {
  it("finds Ops by declared name and classifies apply/reconcile + gate", () => {
    const ops = discoverOps(dir);
    expect(ops.map((o) => o.name)).toEqual(["prod-apply", "prod-reconcile"]); // sorted
    const apply = ops.find((o) => o.name === "prod-apply")!;
    expect(apply.kind).toBe("apply");
    expect(apply.gate).toBe("approve-prod-apply");
    expect(apply.env).toBe("prod"); // parsed so a post-op frame captures the right env
    expect(ops.find((o) => o.name === "prod-reconcile")!.kind).toBe("reconcile");
  });

  it("returns [] for a project with no ops", () => {
    const empty = mkdtempSync(join(tmpdir(), "behold-noops-"));
    expect(discoverOps(empty)).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("substrate from the declared target (#117)", () => {
  const withOp = <T>(source: string, fn: (ops: ReturnType<typeof discoverOps>) => T): T => {
    const d = mkdtempSync(join(tmpdir(), "behold-substrate-"));
    try {
      mkdirSync(join(d, "ops"));
      writeFileSync(join(d, "ops", "x.op.ts"), source);
      return fn(discoverOps(d));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };

  it("maps each of chant's three apply targets to its lexicon", () => {
    const cases: Array<[string, string]> = [
      ["cloudformation", "aws"],
      ["kubectl", "k8s"],
      ["arm", "azure"],
    ];
    for (const [target, lexicon] of cases) {
      const substrate = withOp(
        `const { op } = ApplyOp({ name: "a", env: "prod", target: "${target}" });\n`,
        (ops) => ops[0].substrate,
      );
      expect(substrate).toBe(lexicon);
    }
  });

  it("reads the fixture project's own Ops", () => {
    const ops = discoverOps(dir);
    expect(ops.find((o) => o.name === "prod-apply")!.substrate).toBe("aws");
    // A ReconcileOp declares no target at all — there is no transport to choose.
    // Unscoped is the norm, which is why pickAutoSyncOps treats a lone unscoped
    // Op as covering the estate.
    expect(ops.find((o) => o.name === "prod-reconcile")!.substrate).toBeUndefined();
  });

  it("leaves an unrecognised target unscoped rather than guessing", () => {
    const substrate = withOp(
      `const { op } = ApplyOp({ name: "a", env: "prod", target: "pulumi" });\n`,
      (ops) => ops[0].substrate,
    );
    expect(substrate).toBeUndefined();
  });

  it("leaves an Op declaring no target unscoped", () => {
    const substrate = withOp(`const { op } = ApplyOp({ name: "a", env: "prod" });\n`, (ops) => ops[0].substrate);
    expect(substrate).toBeUndefined();
  });
});

// The emitted-IR half (#284): chant >= 0.50 writes `dist/ops/<name>/op.json`
// per Op, and the ops lens reads it. Discovery lives beside the `*.op.ts`
// scrape above rather than in the lens, so behold has one place that knows
// where a project's Ops are.
describe("discoverOpIrs (#284)", () => {
  /** A project dir with one emitted op.json per name given. */
  const emitted = (names: string[]): string => {
    const d = mkdtempSync(join(tmpdir(), "behold-opir-"));
    for (const n of names) {
      mkdirSync(join(d, "dist", "ops", n), { recursive: true });
      writeFileSync(opIrPath(d, n), JSON.stringify({ formatVersion: "1.0", name: n, phases: [] }));
    }
    return d;
  };

  it("finds every emitted op.json across the served projects, in name order", () => {
    const a = emitted(["zeta-apply", "alpha-apply"]);
    const b = emitted(["mid-reconcile"]);
    try {
      const irs = discoverOpIrs([a, b]);
      expect(irs.map((i) => i.name)).toEqual(["alpha-apply", "mid-reconcile", "zeta-apply"]);
      expect(irs.find((i) => i.name === "mid-reconcile")!.dir).toBe(b);
      expect(irs[0].path).toBe(opIrPath(a, "alpha-apply"));
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("keeps the first project's Op on a name collision, like discoverEstateOps", () => {
    const a = emitted(["prod-apply"]);
    const b = emitted(["prod-apply"]);
    try {
      const irs = discoverOpIrs([a, b]);
      expect(irs).toHaveLength(1);
      expect(irs[0].dir).toBe(a);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("returns [] for an unbuilt project, and for a dist/ops with no op.json in it", () => {
    expect(discoverOpIrs([dir])).toEqual([]); // the fixture project is source-only
    const half = mkdtempSync(join(tmpdir(), "behold-opir-half-"));
    try {
      // `chant build` on an older chant writes workflow.ts but no op.json.
      mkdirSync(join(half, "dist", "ops", "prod-apply"), { recursive: true });
      writeFileSync(join(half, "dist", "ops", "prod-apply", "workflow.ts"), "// generated\n");
      expect(discoverOpIrs([half])).toEqual([]);
    } finally {
      rmSync(half, { recursive: true, force: true });
    }
  });

  it("does not depend on the *.op.ts scrape — an Op the regex misses still has an IR", () => {
    const d = emitted(["built-from-a-const"]);
    try {
      // No source file at all here: the scrape finds nothing, the IR is found.
      expect(discoverOps(d)).toEqual([]);
      expect(discoverOpIrs([d]).map((i) => i.name)).toEqual(["built-from-a-const"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("hangs the IR path off the scraped OpInfo when both agree (the delegated-write surface reads it)", () => {
    const d = mkdtempSync(join(tmpdir(), "behold-opir-join-"));
    try {
      mkdirSync(join(d, "ops"));
      writeFileSync(
        join(d, "ops", "a.op.ts"),
        `import { ApplyOp } from "@intentius/chant-lexicon-temporal";\nconst { op } = ApplyOp({ name: "prod-apply", env: "prod", target: "cloudformation" });\nexport default op;\n`,
      );
      // Unbuilt: the scrape finds the Op, and says so without claiming an IR.
      expect(discoverOps(d)[0].irPath).toBeUndefined();
      mkdirSync(join(d, "dist", "ops", "prod-apply"), { recursive: true });
      writeFileSync(opIrPath(d, "prod-apply"), "{}");
      expect(discoverOps(d)[0].irPath).toBe(opIrPath(d, "prod-apply"));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
