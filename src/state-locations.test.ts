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
import { CHANT_FLOORS, floorFor, WORKSPACE_STATE_LOCATIONS_CHANT_FLOOR } from "./chant-floors.ts";
import { readStateLocations, stateFloorRefusal, stateLocationsFromDocument, type StateLocationsRead } from "./state-locations.ts";
import { readArgv, WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader } from "./workspace-reader.ts";
import { publicReadRefusal } from "./public-mode.ts";
import { stateReachLabel } from "./status-vocabulary.ts";
import stateSchema from "./__fixtures__/state-locations/state.schema.json" with { type: "json" };

// behold#1247. state-all.json is shaped as chant's `workspace state --json` prints it (INTENTIUS/chant#5456,
// schema beside it, copied from chant's packages/core/src/workspace/state.schema.json) for a workspace of five
// members: a chant member and a Pulumi member whose lexicons publish nothing, a cloudformation member with two
// stacks (one reachable, one not), a Terraform member with s3 and local backends whose reach is `unchecked`, and a
// Terraform member chant could not read. The values are written by hand to the schema, not recorded from a run.

const FIX = join(import.meta.dirname, "__fixtures__", "state-locations");
const fixture = (): WorkspaceDocument => JSON.parse(readFileSync(join(FIX, "state-all.json"), "utf8")) as WorkspaceDocument;
const state = (read: StateLocationsRead) => {
  if (!read.ok) throw new Error(read.refusal.error);
  return read.state;
};

describe("the document is shaped as chant's", () => {
  it("state-all.json validates against chant's state schema", () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(stateSchema);
    expect(validate(fixture()), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("the state-locations floor", () => {
  it("registers the read at chant's WORKSPACE_STATE_LOCATIONS_FLOOR", () => {
    const f = floorFor("state locations");
    expect(f.floor).toBe(WORKSPACE_STATE_LOCATIONS_CHANT_FLOOR);
    expect(CHANT_FLOORS).toContain(f);
  });
  it("refuses a chant below it, and passes one at it or an unknown one", () => {
    expect(stateFloorRefusal("0.124.112")).toMatchObject({ code: "chant-too-old", error: expect.stringContaining(WORKSPACE_STATE_LOCATIONS_CHANT_FLOOR) });
    expect(stateFloorRefusal(WORKSPACE_STATE_LOCATIONS_CHANT_FLOOR)).toBeUndefined();
    expect(stateFloorRefusal(undefined)).toBeUndefined();
  });
});

describe("stateLocationsFromDocument", () => {
  const s = state(stateLocationsFromDocument(fixture(), { readAt: "2026-11-21T12:00:00.000Z" }));

  it("keeps every member as chant listed it, and chant's summary", () => {
    expect(s.members.map((m) => [m.member, m.kind, m.status, m.published])).toEqual([
      ["cluster", "chant", "read", false],
      ["legacy", "cloudformation", "read", true],
      ["platform", "terraform", "read", true],
      ["stacks", "pulumi", "read", false],
      ["broken", "terraform", "failed", false],
    ]);
    expect(s.summary).toEqual({ members: 5, published: 2, locations: 5, unreachable: 1 });
    expect(s.readAt).toBe("2026-11-21T12:00:00.000Z");
  });

  it("makes one row per member and environment, and one note row for a member with no location", () => {
    const keys = s.rows.map((r) => `${r.member}/${r.environment ?? "-"}/${r.unit ?? "-"}`);
    expect(keys).toEqual(["cluster/-/-", "legacy/-/billing", "legacy/-/orders", "platform/dev/network", "platform/prod/network", "platform/prod/scratch", "stacks/-/-", "broken/-/-"]);
    const note = (m: string) => s.rows.find((r) => r.member === m)!;
    expect(note("cluster")).toMatchObject({ location: null, backend: null, reach: null, note: "its lexicon publishes no state location" });
    expect(note("stacks").note).toBe("its lexicon publishes no state location");
    expect(note("broken").note).toBe("not read: terraform init was not run in the root");
  });

  it("carries the backend, the location and the lock as chant wrote them, with a masked value masked", () => {
    const dev = s.rows.find((r) => r.member === "platform" && r.environment === "dev")!;
    expect(dev).toMatchObject({ substrate: "terraform", backend: "s3", lock: { mechanism: "dynamodb", location: { table: "acme-tflock" } } });
    expect(dev.location).toEqual({ bucket: "acme-tfstate", key: "dev/network.tfstate", region: "us-east-1", access_key: "***" });
    expect(s.rows.find((r) => r.unit === "scratch")!.lock).toBeNull();
  });

  it("says each reach as chant did: reachable, unreachable with its reason, and unchecked as a label of its own", () => {
    const reach = (unit: string) => s.rows.find((r) => r.unit === unit)!.reach;
    expect(reach("orders")).toEqual({ status: "reachable", label: "reachable", reason: null });
    expect(reach("billing")).toMatchObject({ status: "unreachable", reason: expect.stringContaining("ExpiredToken") });
    expect(reach("scratch")).toEqual({ status: "unchecked", label: "not checked", reason: null });
    expect(stateReachLabel("something-new")).toBe("something-new");
  });

  it("refuses a failure document with chant's code, and another contract", () => {
    const failure = { $schema: fixture().$schema, contract: 1, chant: "0.124.113", error: { code: "workspace-undeclared", message: "no workspace here" } };
    const read = stateLocationsFromDocument(failure);
    expect(read).toMatchObject({ ok: false, refusal: { code: "workspace-undeclared" } });
    expect(stateLocationsFromDocument({ ...fixture(), contract: 2 })).toMatchObject({ ok: false, refusal: { code: "workspace-contract" } });
  });
});

describe("the read", () => {
  const ws = { name: "mixed", root: "/work/mixed", file: "chant.workspace.json", chant: "0.124.113", members: [] } as unknown as Workspace;
  const stub = (answer: () => WorkspaceDocument) => {
    const asked: string[][] = [];
    const reader = {
      async read(command: string, args: string[]) {
        asked.push([command, ...args]);
        return answer();
      },
    } as unknown as WorkspaceReader;
    return { reader, asked };
  };

  it("is one `workspace state --json` read, with --member and --env only when asked", async () => {
    expect(readArgv("state", [])).toEqual(["workspace", "state", "--json"]);
    expect(readArgv("state", ["--member", "platform", "--env", "prod"])).toEqual(["workspace", "state", "--member", "platform", "--env", "prod", "--json"]);
    const all = stub(fixture);
    state(await readStateLocations(ws, { reader: all.reader }));
    expect(all.asked).toEqual([["state"]]);
    const one = stub(fixture);
    const s = state(await readStateLocations(ws, { reader: one.reader, member: "platform", env: "prod" }));
    expect(one.asked).toEqual([["state", "--member", "platform", "--env", "prod"]]);
    expect(s.member).toBe("platform");
  });

  it("is refused whole when chant's read is refused", async () => {
    const refusal = { error: "no", code: "workspace-state", remedy: "r" };
    const r = { read: async () => { throw new WorkspaceReadError(refusal); } } as unknown as WorkspaceReader;
    expect(await readStateLocations(ws, { reader: r })).toEqual({ ok: false, refusal });
  });
});

// The route over the app, with a project chant that prints the fixture for `workspace state ... --json`.
describe("GET /api/workspace/state", () => {
  const made: string[] = [];
  afterAll(() => {
    setServedWorkspace(undefined);
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  function root(version: string): string {
    const dir = mkdtempSync(join(tmpdir(), "behold-1247-state-"));
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
if (argv[0] === "workspace" && argv[1] === "state" && argv[argv.length - 1] === "--json") {
  process.stdout.write(readFileSync(${JSON.stringify(join(FIX, "state-all.json"))}, "utf8"));
} else { process.stderr.write("unexpected " + argv.join(" ")); process.exit(2); }
`,
    );
    chmodSync(bin, 0o755);
    return dir;
  }

  const serve = (dir: string) => {
    const w: Workspace = {
      name: "mixed",
      root: dir,
      file: "chant.workspace.json",
      chant: "0.124.113",
      members: [{ name: "platform", dir: "platform", kind: "terraform" }, { name: "legacy", dir: "legacy", kind: "cloudformation" }] as unknown as Workspace["members"],
    };
    setServedWorkspace(w);
    const broadcaster = new Broadcaster();
    return createApp({ projectDir: dir, workspace: w, port: 0, env: "prod" }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
  };
  const calls = (dir: string) => readFileSync(join(dir, "node_modules", "@intentius", "chant", "bin", "calls"), "utf8").trim().split("\n");

  it("answers a row per member and environment, from one read of every environment", async () => {
    const dir = root("0.124.113");
    const res = await serve(dir).request("/api/workspace/state");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({ workspace: true, chant: "0.124.113", summary: { members: 5, unreachable: 1 } });
    expect(body.rows).toHaveLength(8);
    expect(calls(dir)).toEqual(["workspace state --json"]);
  });

  it("passes ?member and ?env through to chant", async () => {
    const dir = root("0.124.113");
    const res = await serve(dir).request("/api/workspace/state?member=platform&env=prod");
    expect(res.status).toBe(200);
    expect(calls(dir)).toEqual(["workspace state --member platform --env prod --json"]);
  });

  it("is listed in GET /api, and is a GET only", async () => {
    const api = (await (await serve(root("0.124.113")).request("/api")).json()) as { routes: { method: string; path: string }[] };
    expect(api.routes.filter((r) => r.path === "/api/workspace/state")).toEqual([expect.objectContaining({ method: "GET" })]);
  });

  it("refuses a chant below the floor before spawning it", async () => {
    const dir = root("0.124.112");
    const body = (await (await serve(dir).request("/api/workspace/state")).json()) as Record<string, any>;
    expect(body.refusal).toMatchObject({ code: "chant-too-old" });
    expect(body.rows).toBeUndefined();
    expect(() => calls(dir)).toThrow();
  });

  it("refuses an env that is not a name and a member the workspace does not list, and is refused in a public view", async () => {
    const app = serve(root("0.124.113"));
    expect((await app.request("/api/workspace/state?env=--help")).status).toBe(400);
    const res = await app.request("/api/workspace/state?member=nope");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { members: string[] }).members).toEqual(["platform", "legacy"]);
    expect(publicReadRefusal("/api/workspace/state", new URLSearchParams())).toBeDefined();
  });
});
