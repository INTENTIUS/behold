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
import { CHANT_FLOORS, floorFor, OVERLAP_CHANT_FLOOR } from "./chant-floors.ts";
import { collisionsFloorRefusal, collisionsFrom, overlapRefusal, readCollisions } from "./collision-marks.ts";
import { workspaceReader, type WorkspaceDocument } from "./workspace-reader.ts";
import { publicReadRefusal } from "./public-mode.ts";
import statusSchema from "./trunk-lane-schemas/status.schema.json" with { type: "json" };

// #684. status-staging.json is what chant main at e9c996e93 (chant#4025's
// overlap, which ships in 0.124.29; it still calls itself 0.124.28) printed
// for the workspace src/collision-fixture.ts makes: W-001 and W-002 both
// in flight, both changing web/queue.ts, and a release gate waiting in
// staging whose stored change set has one entry on the graph node web/Queue,
// declared in web/queue.ts. status.schema.json in src/trunk-lane-schemas/ is
// refreshed from the same commit; it adds overlap to what the lane's tests read.

const FIX = join(import.meta.dirname, "__fixtures__", "collision-marks");
const fixture = (): WorkspaceDocument => JSON.parse(readFileSync(join(FIX, "status-staging.json"), "utf8")) as WorkspaceDocument;
const DIGEST = "jcs1-sha256:05c8b35bc9a3b2040cf6f057d5846220ca8b30ba4ec99ac962e90ebde753528f";
const AT = new Date("2026-10-17T00:00:00Z");

describe("the recorded document is chant's (#684)", () => {
  it("status-staging.json validates against chant's status schema", () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(statusSchema);
    expect(validate(fixture()), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("the overlap floor (#684, #691)", () => {
  it("registers the overlap read at 0.124.29, degraded below it", () => {
    expect(OVERLAP_CHANT_FLOOR).toBe("0.124.29");
    const f = floorFor("work overlap");
    expect(f.floor).toBe(OVERLAP_CHANT_FLOOR);
    expect(f.degraded).toMatch(/no collision marks/);
    expect(CHANT_FLOORS).toContain(f);
  });
  it("refuses a chant below it, and passes one at it", () => {
    expect(collisionsFloorRefusal("0.124.28")).toMatchObject({ code: "chant-too-old", error: expect.stringContaining("0.124.29") });
    expect(collisionsFloorRefusal("0.124.29")).toBeUndefined();
    expect(collisionsFloorRefusal(undefined)).toBeUndefined();
  });
});

describe("collisionsFrom (#684)", () => {
  it("marks the node two work items reach in one resource", () => {
    const a = collisionsFrom(fixture(), AT)!;
    expect(a.nodes).toEqual([
      {
        node: "web/Queue",
        items: ["work:W-001", "work:W-002"],
        entries: [{ changeSet: DIGEST, member: "web", address: "web", source: "web/queue.ts", items: ["work:W-001", "work:W-002"] }],
      },
    ]);
    expect(a.items.map((i) => [i.item, i.with, i.state])).toEqual([
      ["work:W-001", ["work:W-002"], "in-progress"],
      ["work:W-002", ["work:W-001"], "in-progress"],
    ]);
    expect(a.changeSets).toEqual([DIGEST]);
    expect(a.unattributed).toBe(0);
  });
  it("lists the shared file on the side, with no node", () => {
    expect(collisionsFrom(fixture(), AT)!.files).toEqual([{ items: ["work:W-001", "work:W-002"], files: ["web/queue.ts"] }]);
  });
  it("lists a shared entry with no node on the side, and a pair with only a file marks no node", () => {
    const doc = structuredClone(fixture()) as Record<string, any>;
    doc.overlap.pairs[0].addresses[0].node = null;
    const a = collisionsFrom(doc, AT)!;
    expect(a.nodes).toEqual([]);
    expect(a.unplaced).toEqual([{ items: ["work:W-001", "work:W-002"], changeSet: DIGEST, member: "web", address: "web", source: "web/queue.ts" }]);
    doc.overlap.pairs[0].addresses = [];
    expect(collisionsFrom(doc, AT)!.nodes).toEqual([]);
  });
  it("keeps an in-flight item that collides with none", () => {
    const doc = structuredClone(fixture()) as Record<string, any>;
    doc.overlap.items.push({ item: "work:W-003", path: "work/W-003.md", state: "open", commits: ["abc"] });
    expect(collisionsFrom(doc, AT)!.items.find((i) => i.item === "work:W-003")!.with).toEqual([]);
  });
  it("unions the items when three reach one node", () => {
    const doc = structuredClone(fixture()) as Record<string, any>;
    const addr = doc.overlap.pairs[0].addresses[0];
    doc.overlap.pairs = [
      { items: ["work:W-001", "work:W-002"], files: [], addresses: [addr] },
      { items: ["work:W-001", "work:W-003"], files: [], addresses: [addr] },
      { items: ["work:W-002", "work:W-003"], files: [], addresses: [addr] },
    ];
    expect(collisionsFrom(doc, AT)!.nodes[0].items).toEqual(["work:W-001", "work:W-002", "work:W-003"]);
  });
  it("reads absent overlap (an older chant) and null overlap (no work kind, or a failed read) as different refusals", () => {
    const old = structuredClone(fixture()) as Record<string, any>;
    delete old.overlap;
    expect(overlapRefusal(old)).toMatchObject({ code: "no-overlap", remedy: expect.stringContaining("0.124.29") });
    expect(collisionsFrom(old, AT)).toBeNull();
    const none = structuredClone(fixture()) as Record<string, any>;
    none.overlap = null;
    expect(overlapRefusal(none)).toMatchObject({ code: "overlap-unavailable", error: expect.stringContaining("no work kind") });
  });
});

describe("readCollisions (#684)", () => {
  const ws: Workspace = { name: "acme", root: "/ws", file: "chant.workspace.json", chant: "0.124.29", members: [{ name: "web", dir: "web", kind: "chant" } as Workspace["members"][number]] };
  it("makes one status read, through the reader", async () => {
    const calls: string[][] = [];
    const reader = workspaceReader({
      run: async (argv) => {
        calls.push(argv);
        return { status: 0, stdout: JSON.stringify(fixture()), stderr: "" };
      },
    });
    const read = await readCollisions(ws, { env: "staging", reader, now: () => AT });
    if (!read.ok) throw new Error(read.refusal.error);
    expect(calls).toEqual([["workspace", "status", "staging", "--json"]]);
    expect(read.collisions).toEqual(collisionsFrom(fixture(), AT));
  });
  it("refuses a status with null overlap", async () => {
    const doc = { ...(fixture() as object), overlap: null };
    const reader = workspaceReader({ run: async () => ({ status: 0, stdout: JSON.stringify(doc), stderr: "" }) });
    expect(await readCollisions(ws, { env: "staging", reader })).toMatchObject({ ok: false, refusal: { code: "overlap-unavailable" } });
  });
});

// The route over the app, with a project chant that answers from the fixture.
describe("GET /api/workspace/collisions (#684)", () => {
  const made: string[] = [];
  afterAll(() => {
    setServedWorkspace(undefined);
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  function root(version: string): string {
    const dir = mkdtempSync(join(tmpdir(), "behold-684-"));
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
if (argv.join(" ") === "workspace status staging --json") process.stdout.write(readFileSync(${JSON.stringify(join(FIX, "status-staging.json"))}, "utf8"));
else { process.stderr.write("unexpected " + argv.join(" ")); process.exit(2); }
`,
    );
    chmodSync(bin, 0o755);
    return dir;
  }

  const serve = (dir: string) => {
    const w: Workspace = { name: "acme", root: dir, file: "chant.workspace.json", chant: "0.124.29", members: [{ name: "web", dir: "web", kind: "chant" } as Workspace["members"][number]] };
    setServedWorkspace(w);
    const broadcaster = new Broadcaster();
    return createApp({ projectDir: dir, workspace: w, port: 0, env: "staging" }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
  };

  it("answers the marked node, the items and the shared file", async () => {
    const app = serve(root("0.124.29"));
    const res = await app.request("/api/workspace/collisions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.refusal).toBeUndefined();
    expect(body.chant).toBe("0.124.29");
    expect(body.nodes.map((n: any) => [n.node, n.items])).toEqual([["web/Queue", ["work:W-001", "work:W-002"]]]);
    expect(body.files).toEqual([{ items: ["work:W-001", "work:W-002"], files: ["web/queue.ts"] }]);
  });

  it("refuses on a chant below the floor without spawning it, and says what is degraded", async () => {
    const dir = root("0.124.28");
    const body = (await (await serve(dir).request("/api/workspace/collisions")).json()) as Record<string, any>;
    expect(body.refusal).toMatchObject({ code: "chant-too-old" });
    expect(body.degraded).toMatch(/no collision marks/);
    expect(existsSync(join(dir, "node_modules", "@intentius", "chant", "bin", "calls"))).toBe(false);
  });

  it("offers no write, and is refused in a public view", () => {
    const app = serve(root("0.124.29"));
    expect(app.routes.filter((r) => r.path.includes("collision")).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/workspace/collisions"]);
    expect(publicReadRefusal("/api/workspace/collisions", new URLSearchParams())).toBeDefined();
  });
});
