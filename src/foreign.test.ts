import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GraphIR } from "@intentius/chant";
import { dropForeignDeclarations, foreignNote } from "./foreign.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const own = (id: string, file?: string): GraphIR["nodes"][number] => ({ id, kind: "AWS::S3::Bucket", lexicon: "aws", attrs: {}, ...(file ? { sourceLoc: { file } } : {}) });
const op = (id: string, file: string): GraphIR["nodes"][number] => ({ id, kind: "Temporal::Op", lexicon: "temporal", attrs: {}, sourceLoc: { file } });

describe("dropForeignDeclarations (chant#2058)", () => {
  const ir: GraphIR = {
    nodes: [
      own("assets", "src/assets.ts"),
      own("bare"),
      op("ownOp", "/repo/app/ops/deploy.op.ts"),
      op("apply", "/repo/example-writes/ops/apply.op.ts"),
      op("k3d", "/repo/example-k8s/ops/k3d-apply.op.ts"),
    ],
    edges: [
      { from: "assets", to: "ownOp", kind: "ref" },
      { from: "apply", to: "assets", kind: "ref" },
    ],
    groups: { byStack: { aws: ["assets", "bare"], temporal: ["ownOp", "apply", "k3d"] } },
  };

  it("drops a node whose absolute declaring file is outside the project, with its edges and group seats", () => {
    const out = dropForeignDeclarations(ir, "/repo/app");
    expect(out.nodes.map((n) => n.id)).toEqual(["assets", "bare", "ownOp"]);
    expect(out.edges).toEqual([{ from: "assets", to: "ownOp", kind: "ref" }]);
    expect(out.groups.byStack).toEqual({ aws: ["assets", "bare"], temporal: ["ownOp"] });
    expect(out.foreign).toEqual([
      { id: "apply", kind: "Temporal::Op", file: "/repo/example-writes/ops/apply.op.ts" },
      { id: "k3d", kind: "Temporal::Op", file: "/repo/example-k8s/ops/k3d-apply.op.ts" },
    ]);
  });

  it("keeps an Op declared inside the project, relative paths, and nodes with no source location", () => {
    const out = dropForeignDeclarations(ir, "/repo/app");
    expect(out.nodes.some((n) => n.id === "ownOp")).toBe(true);
    expect(out.nodes.some((n) => n.id === "bare")).toBe(true);
  });

  it("is the same object back when nothing is foreign, and a root that merely prefixes another dir's name is not its parent", () => {
    const clean: GraphIR = { ...ir, nodes: ir.nodes.filter((n) => n.id !== "apply" && n.id !== "k3d") };
    expect(dropForeignDeclarations(clean, "/repo/app")).toBe(clean);
    expect(dropForeignDeclarations({ ...ir, nodes: [op("x", "/repo/app2/ops/x.op.ts")] }, "/repo/app").foreign?.map((f) => f.id)).toEqual(["x"]);
  });

  it("names what was dropped on the note, and why", () => {
    const out = dropForeignDeclarations(ir, "/repo/app");
    expect(foreignNote(out)).toBe("2 declarations outside this project dropped (apply, k3d) — chant graphs Ops from the git root (chant#2058)");
    expect(foreignNote(ir)).toBeUndefined();
  });
});

// The pin: chant's own behaviour, observed. example-carve/app is a two-entity
// aws project with no ops/ of its own, sitting in this repository beside
// example-writes and example-k8s, which declare four Ops between them. chant
// 0.54's graph joins those four into it. The day chant scopes discovery to the
// project (chant#2058) the first assertion fails — and the guard, and this
// file, can retire. Runs only where the example's own install exists (the aws
// lexicon resolves from there); CI's root install does not carry it.
const EXAMPLE = join(ROOT, "example-carve", "app");
const installed = existsSync(join(EXAMPLE, "node_modules", ".bin", "chant"));
describe.skipIf(!installed)("chant#2058 pin — example-carve/app graphs sibling examples' Ops", () => {
  it("chant reports Ops declared outside the project, and the guard drops exactly those", async () => {
    const { stdout } = await promisify(execFile)(join(EXAMPLE, "node_modules", ".bin", "chant"), ["graph", "src", "--format", "ir"], { cwd: EXAMPLE, maxBuffer: 8 * 1024 * 1024 });
    const raw = JSON.parse(stdout) as GraphIR;
    const ops = raw.nodes.filter((n) => n.kind === "Temporal::Op");
    expect(ops.length, "chant#2058 still reproduces — when this fails, chant scoped discovery and src/foreign.ts can retire").toBeGreaterThan(0);
    expect(ops.every((n) => n.sourceLoc?.file && !n.sourceLoc.file.startsWith(EXAMPLE))).toBe(true);
    const out = dropForeignDeclarations(raw, EXAMPLE);
    expect(out.nodes.some((n) => n.kind === "Temporal::Op")).toBe(false);
    expect(out.nodes.length).toBe(raw.nodes.length - ops.length);
    expect(out.foreign?.length).toBe(ops.length);
  }, 60_000);
});
