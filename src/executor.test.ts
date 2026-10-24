import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executorsFromComposites, executorsOf, executorDesignation, setExecutorSource, EXECUTOR_CHANT_FLOOR } from "./executor.ts";
import { CHANT_FLOORS } from "./chant-floors.ts";
import { workspaceReader } from "./workspace-reader.ts";

// #470, executor half. The fixture is what a local pack of chant's integration/chant-goal at b0b71f0f1
// (0.124.47) printed for `chant workspace graph --composites` over the reference workspace, whose
// `delivery` member declares { name: "prod", executor: { forge: "github", workflow: "deploy-prod.yml" } }.
const real = JSON.parse(readFileSync(new URL("./__fixtures__/executor/composites-0.124.47.json", import.meta.url), "utf8"));

afterEach(() => setExecutorSource(undefined));

describe("executor floor", () => {
  it("is chant 0.124.47 and registered", () => {
    expect(EXECUTOR_CHANT_FLOOR).toBe("0.124.47");
    expect(CHANT_FLOORS.some((f) => f.floor === EXECUTOR_CHANT_FLOOR && f.read === "environment executor")).toBe(true);
  });
});

describe("executorsFromComposites", () => {
  it("reads a declared executor and leaves undeclared envs out", () => {
    const t = executorsFromComposites(real);
    expect(t.get("delivery")).toEqual({ prod: { forge: "github", workflow: "deploy-prod.yml" } });
  });

  it("keeps an unreadable config as a refusal (fail-closed)", () => {
    const doc = { components: [{ member: "m", environments: [{ name: "prod", executor: { forge: null, workflow: null, reason: { code: "executor-config-unreadable", message: "boom" } } }] }] };
    expect(executorsFromComposites(doc).get("m")!.prod).toEqual({ invalid: expect.stringMatching(/could not read m's chant\.config\.ts.*boom/) });
  });

  it("reads a document from a chant below the floor (no executor key) as none declared", () => {
    const doc = { components: [{ member: "m", environments: [{ name: "prod" }] }] };
    expect(executorsFromComposites(doc).size).toBe(0);
  });

  it("never derives a designation from a chant-components-<env> workflow name", () => {
    const doc = { components: [{ member: "m", workflow: "chant-components-prod", environments: [{ name: "prod", executor: { forge: null, workflow: null, reason: { code: "executor-none-declared", message: "" } } }] }] };
    expect(executorsFromComposites(doc).size).toBe(0);
  });
});

describe("executorDesignation", () => {
  it("asks chant for the composites graph and answers per env", async () => {
    const argvs: string[][] = [];
    const reader = workspaceReader({ run: async (argv) => ((argvs.push(argv), { status: 0, stdout: JSON.stringify(real), stderr: "" })) });
    setExecutorSource(async (_root, member) => reader.read("graph", ["--composites", ...(member ? ["--member", member] : [])]));
    expect(await executorDesignation("/nowhere/a", "prod")).toEqual({ forge: "github", workflow: "deploy-prod.yml" });
    expect(await executorDesignation("/nowhere/a", "staging")).toBeUndefined();
    expect(await executorDesignation("/nowhere/a", undefined)).toBeUndefined();
    expect(argvs[0]).toEqual(["workspace", "graph", "--composites"]);
    expect(argvs.length).toBe(1);
  });

  it("is none when chant refuses the read", async () => {
    setExecutorSource(async () => { throw new Error("not a workspace"); });
    expect(await executorsOf("/nowhere/b")).toEqual({});
  });
});

describe("a directory inside a declared workspace, not served as one", () => {
  it("takes only its own member's designation, never a sibling's", async () => {
    const root = mkdtempSync(join(tmpdir(), "behold-executor-ws-"));
    try {
      writeFileSync(join(root, "chant.workspace.json"), "{}");
      mkdirSync(join(root, "app"));
      mkdirSync(join(root, "delivery"));
      const doc = { ...real, members: [{ name: "app", dir: "app" }, { name: "delivery", dir: "delivery" }] };
      setExecutorSource(async () => doc);
      expect(await executorsOf(join(root, "delivery"))).toEqual({ prod: { forge: "github", workflow: "deploy-prod.yml" } });
      expect(await executorsOf(join(root, "app"))).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
