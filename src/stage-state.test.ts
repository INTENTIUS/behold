import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { setServedWorkspace, type Workspace } from "./workspace.ts";
import { CHANT_FLOORS, floorFor, STAGE_STATE_CHANT_FLOOR } from "./chant-floors.ts";
import { queuesOf, readStageState, stageNames, stagesFloorRefusal, stagesFromStatus, type StageStateRead } from "./stage-state.ts";
import { WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader } from "./workspace-reader.ts";
import { publicReadRefusal } from "./public-mode.ts";
import statusSchema from "./__fixtures__/stage-state/status.schema.json" with { type: "json" };

// #1236. status-prod.json is what chant's `workspaceStatus` printed at
// 2026-11-20T12:00:00Z for the workspace scripts/record-stage-state.ts builds,
// read from the delivery integration branch (chant main plus chant#5342's
// pull request, core stamped 0.124.110). Three members, each with its own
// pipeline and ledger: network (terraform), shop (pulumi) and orders-db (sql).
// shop's canary soak holds the promote into prod and a rollback of prod waits
// at its gate; network's prod gate waits on a release whose risk is over the
// stage's threshold; orders-db's prod is held and its rollback is held.
// status.schema.json beside it is chant's, from the same tree.

const FIX = join(import.meta.dirname, "__fixtures__", "stage-state");
const fixture = (): WorkspaceDocument => JSON.parse(readFileSync(join(FIX, "status-prod.json"), "utf8")) as WorkspaceDocument;
const state = (read: StageStateRead) => {
  if (!read.ok) throw new Error(read.refusal.error);
  return read.state;
};
const V100 = "jcs1-sha256:f8d76d247e33aa64ecf1fc6b9f3e2d56cc425b466df52e4a1da21c810a237059";

describe("the recorded document is chant's (#1236)", () => {
  it("status-prod.json validates against chant's status schema", () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(statusSchema);
    expect(validate(fixture()), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("the stage-state floor (#1236, #691)", () => {
  it("registers the read at chant's STAGE_STATUS_FLOOR", () => {
    expect(STAGE_STATE_CHANT_FLOOR).toBe("0.124.110");
    const f = floorFor("stage state");
    expect(f.floor).toBe(STAGE_STATE_CHANT_FLOOR);
    expect(CHANT_FLOORS).toContain(f);
  });
  it("refuses a chant below it, and passes one at it or an unknown one", () => {
    expect(stagesFloorRefusal("0.124.109")).toMatchObject({ code: "chant-too-old", error: expect.stringContaining("0.124.110") });
    expect(stagesFloorRefusal("0.124.110")).toBeUndefined();
    expect(stagesFloorRefusal(undefined)).toBeUndefined();
  });
});

describe("stagesFromStatus (#1236)", () => {
  it("lists every stage of each member's pipeline, whatever its kind, in pipeline order", () => {
    const s = state(stagesFromStatus(fixture()));
    expect(s.env).toBe("prod");
    expect(s.members.map((m) => [m.member, m.kind, m.pipeline, m.stages.map((x) => x.name)])).toEqual([
      ["network", "terraform", "net", ["dev", "prod"]],
      ["shop", "pulumi", "shop", ["dev", "canary", "prod"]],
      ["orders-db", "sql", "db", ["dev", "prod"]],
    ]);
    expect(s.others).toEqual([]);
    // Every member's stage carries the release it runs.
    for (const m of s.members) for (const st of m.stages) expect(st.release?.label).toMatch(/^v1\.[01]\.0$/);
  });

  it("draws a held canary and a requested rollback as chant wrote them", () => {
    const shop = state(stagesFromStatus(fixture())).members.find((m) => m.member === "shop")!;
    const [dev, canary, prod] = shop.stages;
    expect(canary).toMatchObject({ canary: true, after: ["dev"], soak: { state: "soaking", leftMs: 3_600_000, to: "prod", due: "2026-11-20T13:00:00.000Z" } });
    expect(canary!.risk).toMatchObject({ level: "medium", over: true, overBy: ["the score 0.4 is above 0.3"] });
    expect(prod!.canaryHolds).toEqual([{ stage: "canary", state: "soaking", due: "2026-11-20T13:00:00.000Z", leftMs: 3_600_000, holding: true }]);
    expect(prod!.gate).toMatchObject({ state: "approved", label: "v1.1.0", approvals: 1, needed: 1 });
    expect(prod!.onVerifyFail).toBe("rollback");
    expect(prod!.rollback).toMatchObject({
      by: "ci",
      failure: "verify",
      failed: { label: "v1.1.0" },
      to: { digest: V100, label: "v1.0.0" },
      gate: "prod-rollback",
      state: "pending",
      approve: `chant approve shop prod-rollback --env prod --plan ${V100}`,
      command: "chant components rollback prod --requested",
    });
    expect(dev!.paused).toMatchObject({ by: "carol", reason: "db upgrade", waiting: [{ label: "v1.1.0" }] });
  });

  it("joins the queue on the member, pipeline and stage name", () => {
    const s = state(stagesFromStatus(fixture()));
    const queue = (member: string, stage: string) => s.members.find((m) => m.member === member)!.stages.find((x) => x.name === stage)!.queue;
    expect(queue("shop", "prod")).toMatchObject({ inStage: null, waiting: [{ label: "v1.2.0" }], replaced: [] });
    expect(queue("shop", "dev")).toBeNull();
    expect(queue("network", "prod")).toBeNull();
  });

  it("gives a pending gate its approve line, and the risk that adds approvals its reasons", () => {
    const network = state(stagesFromStatus(fixture())).members.find((m) => m.member === "network")!;
    const prod = network.stages[1]!;
    expect(prod.gate).toMatchObject({ state: "pending", label: "v1.1.0", approvals: 0, approve: expect.stringMatching(/^chant approve net prod --env prod --plan /) });
    expect(prod.risk).toMatchObject({ score: 0.55, reads: true, approveAbove: 0.3, over: true, overBy: ["the score 0.55 is above 0.3"] });
  });

  it("joins a hold on the stage name, and keeps a held rollback", () => {
    const db = state(stagesFromStatus(fixture())).members.find((m) => m.member === "orders-db")!;
    expect(db.stages[0]!.held).toBeNull();
    expect(db.stages[1]!.held).toEqual({ kind: "hold", until: null, reason: "schema review", description: "Read the orders migration plan before lifting the hold." });
    expect(db.stages[1]!.rollbackHeld).toMatchObject({ failureId: "f2", reason: "stage prod ran no earlier release of orders-db", failure: "verify" });
    expect(db.stages[1]!.rollback).toBeNull();
  });

  it("lists a member with no pipeline apart", () => {
    const doc = fixture() as Record<string, any>;
    delete doc.members[2].pipeline;
    const s = state(stagesFromStatus(doc));
    expect(s.members.map((m) => m.member)).toEqual(["network", "shop"]);
    expect(s.others).toEqual([{ member: "orders-db", kind: "sql" }]);
  });

  it("refuses another contract and a failure document", () => {
    expect(stagesFromStatus({ ...fixture(), contract: 2 })).toMatchObject({ ok: false });
    expect(stagesFromStatus({ contract: 1, error: { code: "no-workspace", message: "none" } })).toMatchObject({ ok: false, refusal: { code: "no-workspace" } });
  });

  it("names every stage once, and lists queues by member, pipeline and stage", () => {
    expect(stageNames(fixture())).toEqual(["dev", "prod", "canary"]);
    expect([...queuesOf(fixture()).keys()]).toEqual(["shop\u0000shop\u0000prod"]);
  });
});

describe("readStageState (#1236)", () => {
  const ws = { name: "acme", root: "/nowhere", file: "chant.workspace.json", members: [] } as unknown as Workspace;
  const reader = (answer: (env: string) => WorkspaceDocument) => {
    const asked: string[] = [];
    const r = {
      read: async (command: string, args: string[]) => {
        expect(command).toBe("status");
        asked.push(args[0]!);
        return answer(args[0]!);
      },
      readTrunk: async () => {
        throw new Error("not a trunk read");
      },
    } as unknown as WorkspaceReader;
    return { r, asked };
  };

  it("reads the served env, then each other stage name for that stage's queue", async () => {
    const { r, asked } = reader((env) => {
      const doc = fixture() as Record<string, any>;
      doc.env = env;
      const shop = doc.members[1];
      // status lists the queues of the env asked for only.
      shop.stageQueues = env === "dev" ? [{ pipeline: "shop", stage: "dev", inStage: { digest: "d", label: "v1.1.0", at: "t" }, waiting: [], replaced: [] }] : env === "prod" ? shop.stageQueues : undefined;
      return doc;
    });
    const s = state(await readStageState(ws, { env: "prod", reader: r, now: () => new Date("2026-11-20T12:00:00Z") }));
    expect(asked.sort()).toEqual(["canary", "dev", "prod"]);
    expect(s.readAt).toBe("2026-11-20T12:00:00.000Z");
    const shop = s.members.find((m) => m.member === "shop")!;
    expect(shop.stages[0]!.queue).toMatchObject({ inStage: { label: "v1.1.0" } });
    expect(shop.stages[2]!.queue).toMatchObject({ waiting: [{ label: "v1.2.0" }] });
    expect(s.queuesUnread).toEqual([]);
  });

  it("keeps the stages when another env's read is refused, and says which queue went unread", async () => {
    const refusal = { error: "no", code: "workspace-status", remedy: "r" };
    const { r } = reader((env) => {
      if (env === "canary") throw new WorkspaceReadError(refusal);
      return fixture();
    });
    const s = state(await readStageState(ws, { env: "prod", reader: r }));
    expect(s.members).toHaveLength(3);
    expect(s.queuesUnread).toEqual([{ stage: "canary", refusal }]);
  });

  it("is refused whole when the served env's read is refused", async () => {
    const refusal = { error: "no", code: "workspace-status", remedy: "r" };
    const { r } = reader(() => {
      throw new WorkspaceReadError(refusal);
    });
    expect(await readStageState(ws, { env: "prod", reader: r })).toEqual({ ok: false, refusal });
  });
});

// The route over the app, with a project chant that prints the fixture for
// every `workspace status <env> --json`.
describe("GET /api/workspace/stages (#1236)", () => {
  const made: string[] = [];
  afterAll(() => {
    setServedWorkspace(undefined);
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  function root(version: string): string {
    const dir = mkdtempSync(join(tmpdir(), "behold-1236-stages-"));
    made.push(dir);
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
appendFileSync(join(__dirname, "calls"), argv.join(" ") + "\\n");
if (argv[0] === "workspace" && argv[1] === "status" && argv[3] === "--json") {
  const d = JSON.parse(readFileSync(${JSON.stringify(join(FIX, "status-prod.json"))}, "utf8"));
  d.env = argv[2];
  process.stdout.write(JSON.stringify(d));
} else { process.stderr.write("unexpected " + argv.join(" ")); process.exit(2); }
`,
    );
    chmodSync(bin, 0o755);
    return dir;
  }

  const serve = (dir: string) => {
    const w: Workspace = { name: "acme", root: dir, file: "chant.workspace.json", chant: "0.124.110", members: [{ name: "shop", dir: "shop", kind: "pulumi" } as unknown as Workspace["members"][number]] };
    setServedWorkspace(w);
    const broadcaster = new Broadcaster();
    return createApp({ projectDir: dir, workspace: w, port: 0, env: "prod" }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
  };

  it("answers each member's stages", async () => {
    const dir = root("0.124.110");
    const res = await serve(dir).request("/api/workspace/stages");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({ workspace: true, chant: "0.124.110", env: "prod" });
    expect(body.members.map((m: any) => m.member)).toEqual(["network", "shop", "orders-db"]);
    expect(body.members[1].stages[2].rollback.state).toBe("pending");
    const calls = readFileSync(join(dir, "node_modules", "@intentius", "chant", "bin", "calls"), "utf8").trim().split("\n").sort();
    expect(calls).toEqual(["workspace status canary --json", "workspace status dev --json", "workspace status prod --json"]);
  });

  it("refuses a chant below the floor before spawning it", async () => {
    const dir = root("0.124.109");
    const body = (await (await serve(dir).request("/api/workspace/stages")).json()) as Record<string, any>;
    expect(body.refusal).toMatchObject({ code: "chant-too-old" });
    expect(body.members).toBeUndefined();
  });

  it("refuses an env that is not a name, and is refused in a public view", async () => {
    const res = await serve(root("0.124.110")).request("/api/workspace/stages?env=--help");
    expect(res.status).toBe(400);
    expect(publicReadRefusal("/api/workspace/stages", new URLSearchParams())).toBeDefined();
  });
});
