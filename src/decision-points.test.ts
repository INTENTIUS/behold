import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { setServedWorkspace, type Workspace } from "./workspace.ts";
import { CHANT_FLOORS, DECISION_POINTS_CHANT_FLOOR, floorFor } from "./chant-floors.ts";
import { gateOfSubject, openPointsFrom, pointsFloorRefusal, readOpenPoints } from "./decision-points.ts";
import { gatesFromStatus } from "./workspace-gates.ts";
import { pointsArgv, workspaceReader, WorkspaceReadError, type WorkspaceDocument } from "./workspace-reader.ts";
import { publicReadRefusal } from "./public-mode.ts";
import statusSchema from "./trunk-lane-schemas/status.schema.json" with { type: "json" };

// #472. points-open.json and status-staging.json are what chant 0.124.31
// printed for the workspace src/decision-points-fixture.ts makes: two open
// questions, staging-apply-ec72c7930446 (asked for gate approve-apply of op
// deploy in staging, whose pending fact names it) and launch-tier-1f278d6a8207
// (asked about L-7, which no gate waits on).

const FIX = join(import.meta.dirname, "__fixtures__", "decision-points");
const doc = (name: string): WorkspaceDocument => JSON.parse(readFileSync(join(FIX, name), "utf8")) as WorkspaceDocument;
const AT = new Date("2026-10-20T00:00:00Z");
const GATE_Q = "staging-apply-ec72c7930446";
const LOOSE_Q = "launch-tier-1f278d6a8207";

describe("the recorded documents are chant's (#472)", () => {
  it("points-open.json validates against chant's points schema", () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "node_modules", "@intentius", "chant", "src", "workspace", "points.schema.json"), "utf8"));
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
    expect(validate(doc("points-open.json")), JSON.stringify(validate.errors)).toBe(true);
  });
  it("status-staging.json validates against chant's status schema", () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(statusSchema);
    expect(validate(doc("status-staging.json")), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("the decision points floor (#472, #691)", () => {
  it("registers the read at 0.107.0, degraded below it", () => {
    expect(DECISION_POINTS_CHANT_FLOOR).toBe("0.107.0");
    const f = floorFor("decision points");
    expect(f.floor).toBe(DECISION_POINTS_CHANT_FLOOR);
    expect(f.degraded).toMatch(/no open decision points/);
    expect(CHANT_FLOORS).toContain(f);
  });
  it("refuses a chant below it, and passes one at it", () => {
    expect(pointsFloorRefusal("0.106.0")).toMatchObject({ code: "chant-too-old", error: expect.stringContaining("0.107.0") });
    expect(pointsFloorRefusal("0.107.0")).toBeUndefined();
    expect(pointsFloorRefusal(undefined)).toBeUndefined();
  });
});

describe("openPointsFrom (#472)", () => {
  it("lists each open question with its point's text, who may answer, and chant's answer line", () => {
    const read = openPointsFrom(doc("points-open.json"), AT);
    if (!read.ok) throw new Error(read.refusal.error);
    expect(read.points.points.map((p) => p.id)).toEqual([LOOSE_Q, GATE_Q]);
    expect(read.points.points[1]).toEqual({
      id: GATE_Q,
      point: "staging-apply",
      title: "Apply this plan to staging",
      question: "Should this plan be applied to staging?",
      questionType: "noul",
      candidates: [true, false],
      subject: "gate:deploy/approve-apply@staging",
      gate: { op: "deploy", gate: "approve-apply", env: "staging" },
      state: "escalated",
      quorum: { count: 2, roles: ["maintainer"] },
      model: null,
      askedOn: "2026-10-20",
      askedBy: null,
      stale: false,
      path: `answers/${GATE_Q}.md`,
      command: `chant workspace points answer ${GATE_Q} --answer <value> --by <name>`,
    });
    expect(read.points.points[0]).toMatchObject({ point: "launch-tier", subject: "L-7", gate: null, candidates: ["small", "large"], quorum: { count: 1, roles: [] } });
    expect(read.points.unread).toEqual([]);
  });

  it("gives the same answer line chant puts on the gate that waits on the question", () => {
    const gates = gatesFromStatus(doc("status-staging.json"), "/ws");
    if (!gates.ok) throw new Error(gates.refusal.error);
    const [g] = gates.gates;
    expect(g.answer).toEqual({ point: "staging-apply", id: GATE_Q, path: `answers/${GATE_Q}.md` });
    const read = openPointsFrom(doc("points-open.json"), AT);
    if (!read.ok) throw new Error(read.refusal.error);
    expect(read.points.points.find((p) => p.id === g.answer!.id)!.command).toBe(g.approve);
  });

  it("drops answered and withdrawn questions, and carries a model's proposal", () => {
    const d = doc("points-open.json");
    const [loose, gated] = d.questions as Record<string, unknown>[];
    d.questions = [
      { ...loose, state: "proposed", model: { answer: "large", confidence: 0.9, threshold: 0.8, model: "m-1", backend: "b", observed: true, reason: null } },
      { ...gated, open: false, state: "answered" },
    ];
    const read = openPointsFrom(d, AT);
    if (!read.ok) throw new Error(read.refusal.error);
    expect(read.points.points).toHaveLength(1);
    expect(read.points.points[0]).toMatchObject({ state: "proposed", model: { answer: "large", confidence: 0.9, threshold: 0.8, model: "m-1" } });
  });

  it("names an answer kind chant could not read, and refuses a document that failed whole", () => {
    const d = doc("points-open.json");
    d.sources = [{ kind: "answers/answer.kind.mjs", points: null, reason: { code: "kind-unreadable", message: "no such file" } }];
    const read = openPointsFrom(d, AT);
    expect(read.ok && read.points.unread).toEqual([{ kind: "answers/answer.kind.mjs", code: "kind-unreadable", message: "no such file" }]);
    const failed = openPointsFrom({ contract: 1, chant: "0.124.31", error: { code: "declaration-missing", message: "no chant.workspace.json", location: null } }, AT);
    expect(failed).toMatchObject({ ok: false, refusal: { code: "declaration-missing" } });
  });

  it("reads a gate from a gate subject, and nothing from any other", () => {
    expect(gateOfSubject("gate:deploy/approve-apply")).toEqual({ op: "deploy", gate: "approve-apply", env: null });
    expect(gateOfSubject("gate:deploy/approve-apply@prod")).toEqual({ op: "deploy", gate: "approve-apply", env: "prod" });
    expect(gateOfSubject("W-001")).toBeNull();
    expect(gateOfSubject(null)).toBeNull();
  });
});

describe("the points read goes through the reader (#468, #472)", () => {
  it("is one chant call of workspace points --open --json, and refuses another contract", async () => {
    const calls: string[][] = [];
    const reader = workspaceReader({
      run: async (argv) => {
        calls.push(argv);
        return { status: 0, stdout: JSON.stringify({ ...doc("points-open.json"), contract: 2 }), stderr: "" };
      },
    });
    await expect(reader.readPoints()).rejects.toThrow(WorkspaceReadError);
    await expect(reader.readPoints()).rejects.toThrow(/chant workspace points --open wrote a document with contract 2/);
    expect(calls[0]).toEqual(["workspace", "points", "--open", "--json"]);
    expect(pointsArgv()).toEqual(calls[0]);
  });
  it("hands a refusal back rather than throwing", async () => {
    const reader = workspaceReader({ run: async () => ({ status: 1, stdout: "", stderr: "boom" }) });
    const ws: Workspace = { name: "acme", root: "/ws", file: "chant.workspace.json", chant: "0.124.31", members: [] };
    expect(await readOpenPoints(ws, { reader })).toMatchObject({ ok: false, refusal: { code: "workspace-points" } });
  });
});

describe("GET /api/workspace/points (#472)", () => {
  const made: string[] = [];
  afterAll(() => {
    setServedWorkspace(undefined);
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  function root(version: string): string {
    const dir = mkdtempSync(join(tmpdir(), "behold-472-"));
    made.push(dir);
    mkdirSync(join(dir, "web"));
    const pkg = join(dir, "node_modules", "@intentius", "chant");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/chant", version, main: "index.js", bin: { chant: "bin/chant" } }));
    writeFileSync(join(pkg, "index.js"), "");
    const bin = join(pkg, "bin", "chant");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const { readFileSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
appendFileSync(join(__dirname, "calls"), JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
if (argv.join(" ") === "workspace points --open --json") process.stdout.write(readFileSync(${JSON.stringify(join(FIX, "points-open.json"))}, "utf8"));
else if (argv.join(" ") === "workspace status staging --json") process.stdout.write(readFileSync(${JSON.stringify(join(FIX, "status-staging.json"))}, "utf8"));
else { process.stderr.write("unexpected " + argv.join(" ")); process.exit(2); }
`,
    );
    chmodSync(bin, 0o755);
    return dir;
  }

  const serve = (dir: string) => {
    const w: Workspace = { name: "acme", root: dir, file: "chant.workspace.json", chant: "0.124.31", members: [{ name: "web", dir: "web", kind: "chant" } as Workspace["members"][number]] };
    setServedWorkspace(w);
    const broadcaster = new Broadcaster();
    return createApp({ projectDir: dir, workspace: w, port: 0, env: "staging" }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
  };

  it("answers the open points, and the gate that waits on one names it", async () => {
    const app = serve(root("0.124.31"));
    const body = (await (await app.request("/api/workspace/points")).json()) as Record<string, any>;
    expect(body.refusal).toBeUndefined();
    expect(body.chant).toBe("0.124.31");
    expect(body.points.map((p: any) => [p.id, p.gate])).toEqual([
      [LOOSE_Q, null],
      [GATE_Q, { op: "deploy", gate: "approve-apply", env: "staging" }],
    ]);
    const gates = (await (await app.request("/api/workspace/gates?env=staging")).json()) as Record<string, any>;
    expect(gates.gates.map((g: any) => [g.key, g.answer?.id])).toEqual([["web/deploy/approve-apply", GATE_Q]]);
  });

  it("refuses to approve a gate that waits on a decision point, and runs no approve", async () => {
    const dir = root("0.124.31");
    const res = await serve(dir).request("/api/workspace/gates/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "web/deploy/approve-apply", env: "staging" }) });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, any>;
    expect(body.code).toBe("decision-point");
    expect(body.error).toContain(`chant workspace points answer ${GATE_Q}`);
    const calls = readFileSync(join(dir, "node_modules", "@intentius", "chant", "bin", "calls"), "utf8");
    expect(calls).not.toMatch(/"approve"/);
    expect(calls).not.toMatch(/"answer"/);
  });

  it("refuses on a chant below the floor without spawning it, and says what is degraded", async () => {
    const dir = root("0.106.0");
    const body = (await (await serve(dir).request("/api/workspace/points")).json()) as Record<string, any>;
    expect(body.refusal).toMatchObject({ code: "chant-too-old" });
    expect(body.points).toEqual([]);
    expect(body.degraded).toMatch(/no open decision points/);
    expect(existsSync(join(dir, "node_modules", "@intentius", "chant", "bin", "calls"))).toBe(false);
  });

  it("offers no write, and is refused in a public view", () => {
    const app = serve(root("0.124.31"));
    expect(app.routes.filter((r) => r.path.includes("points")).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/workspace/points"]);
    expect(publicReadRefusal("/api/workspace/points", new URLSearchParams())).toBeDefined();
  });
});
