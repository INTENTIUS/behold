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
import { CHANT_FLOORS, FEATURE_FLAGS_CHANT_FLOOR, floorFor } from "./chant-floors.ts";
import { gatesFromStatus } from "./workspace-gates.ts";
import { flagsFloorRefusal, flagsFrom, flagsFromStatus, flagState, paramMoves, readFeatureFlags, shownKey, turnOnLines } from "./feature-flags.ts";
import { workspaceReader, type WorkspaceDocument } from "./workspace-reader.ts";
import { publicReadRefusal } from "./public-mode.ts";
import showSchema from "./trunk-lane-schemas/change-set-show.schema.json" with { type: "json" };
import changeSetSchema from "./trunk-lane-schemas/change-set.schema.json" with { type: "json" };
import statusSchema from "./trunk-lane-schemas/status.schema.json" with { type: "json" };

// #683. The fixtures are what chant main at 0689d28f0 (chant#4024's flags,
// which ship in 0.124.29; it still calls itself 0.124.28) printed for the
// workspace src/feature-flags-fixture.ts makes: member `web` promoting staging
// then prod, the flag new-checkout on in staging and off in prod, the flag
// old-banner on in both and stale (its work item's decisions are all
// confirmed, WSP118), and a release gate waiting in staging whose stored
// change set moves the parameter newCheckout from false to true on component
// `web`, an entry chant maps to no graph node. status.schema.json in
// src/trunk-lane-schemas/ is refreshed from the same commit; it only adds
// featureFlags to what the lane's tests read.

const FIX = join(import.meta.dirname, "__fixtures__", "feature-flags");
const fixture = (name: string): WorkspaceDocument => JSON.parse(readFileSync(join(FIX, name), "utf8")) as WorkspaceDocument;
const DIGEST = "jcs1-sha256:05c8b35bc9a3b2040cf6f057d5846220ca8b30ba4ec99ac962e90ebde753528f";
const RELEASE = `jcs1-sha256:${"f1".repeat(32)}`;
const GATE = "web/release/promote";
const AT = new Date("2026-10-17T00:00:00Z");

/** The answer from the recorded documents, as readFeatureFlags builds it. */
function answer(shown: WorkspaceDocument = fixture("change-set-show.json")) {
  const gatesOf = (name: string) => {
    const read = gatesFromStatus(fixture(name), "/ws");
    if (!read.ok) throw new Error(read.refusal.error);
    return read.gates.map(({ dir: _dir, ...g }) => g);
  };
  return flagsFrom({
    status: fixture("status-staging.json"),
    env: "staging",
    gates: [
      { env: "staging", gates: gatesOf("status-staging.json") },
      { env: "prod", gates: gatesOf("status-prod.json") },
    ],
    shown: new Map([[shownKey("staging", GATE), shown]]),
    at: AT,
  })!;
}

describe("the recorded documents are chant's (#683)", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  it.each([
    ["status-staging.json", statusSchema],
    ["status-prod.json", statusSchema],
    ["change-set-show.json", showSchema],
  ])("%s validates against chant's schema", (name, schema) => {
    const validate = ajv.compile(schema);
    expect(validate(fixture(name)), JSON.stringify(validate.errors)).toBe(true);
  });
  it("the stored change set validates against chant's change-set schema", () => {
    const validate = ajv.compile(changeSetSchema);
    expect(validate(fixture("stored-change-set.json")), JSON.stringify(validate.errors)).toBe(true);
    expect(fixture("change-set-show.json").changeSet).toEqual(fixture("stored-change-set.json"));
  });
});

describe("the flags' floor (#683, #691)", () => {
  it("registers the feature-flags read at 0.124.29, degraded below it", () => {
    expect(FEATURE_FLAGS_CHANT_FLOOR).toBe("0.124.29");
    const f = floorFor("feature flags");
    expect(f.floor).toBe(FEATURE_FLAGS_CHANT_FLOOR);
    expect(f.degraded).toMatch(/no flag marks/);
    expect(CHANT_FLOORS).toContain(f);
  });
  it("refuses a chant below it, and passes one at it", () => {
    expect(flagsFloorRefusal("0.124.28")).toMatchObject({ code: "chant-too-old", error: expect.stringContaining("0.124.29") });
    expect(flagsFloorRefusal("0.124.29")).toBeUndefined();
    expect(flagsFloorRefusal(undefined)).toBeUndefined();
  });
});

describe("flagsFrom (#683)", () => {
  it("marks new-checkout on in staging and off in prod, in promotion order", () => {
    const a = answer();
    expect(a.environments).toEqual(["staging", "prod"]);
    expect(a.order).toBe("promotion");
    const f = a.flags.find((x) => x.id === "new-checkout")!;
    expect(f).toMatchObject({ key: "web/new-checkout", member: "web", param: "newCheckout", owner: "alice", work: { id: "W-002", state: "in-progress" }, stale: false, path: "flags/new-checkout.flag.md" });
    expect(f.envs).toEqual({ staging: { value: true, state: "on" }, prod: { value: false, state: "off" } });
  });
  it("ties cards to a flag by its member, since chant names no node that reads a parameter", () => {
    expect(answer().nodes).toBe("member");
  });
  it("marks the flag the stale-flag lint reports", () => {
    const a = answer();
    expect(a.flags.filter((f) => f.stale).map((f) => f.id)).toEqual(["old-banner"]);
    expect(a.flags.find((f) => f.id === "old-banner")!.implements).toEqual([{ id: "d-001", state: "confirmed", confirmed: true }]);
  });
  it("finds the flip waiting at staging's gate in its change set, with no node for the component entry", () => {
    const f = answer().flags.find((x) => x.id === "new-checkout")!;
    expect(f.waiting).toEqual([
      { env: "staging", gate: GATE, changeSet: DIGEST, releaseDigest: RELEASE, gitSha: expect.stringMatching(/^[0-9a-f]{40}$/), before: false, after: true, entries: [{ address: "web", node: null }] },
    ]);
    expect(answer().flags.find((x) => x.id === "old-banner")!.waiting).toEqual([]);
  });
  it("gives the lines that turn a flag on where it is off, and none where it is on", () => {
    const f = answer().flags.find((x) => x.id === "new-checkout")!;
    expect(f.turnOn).toEqual([
      {
        env: "prod",
        lines: [
          `echo '{"values":{"staging":true,"prod":true}}' | chant workspace records amend new-checkout --kind flags/flag.kind.mjs --set -`,
          "git commit -m 'flags: turn on new-checkout in prod' flags/new-checkout.flag.md",
        ],
      },
    ]);
    expect(answer().flags.find((x) => x.id === "old-banner")!.turnOn).toEqual([]);
  });
  it("lists a gate's change set that could not be read, and finds no flip in it", () => {
    const a = answer({ error: "x", code: "no-change-set", remedy: "fetch chant/lifecycle" } as unknown as WorkspaceDocument);
    expect(a.refusals).toEqual([{ env: "staging", gate: GATE, error: "x", remedy: "fetch chant/lifecycle" }]);
    expect(a.flags.find((x) => x.id === "new-checkout")!.waiting).toEqual([]);
  });
  it("reads an older status, with no featureFlags, as no answer, and null flags as unreadable", () => {
    const old = structuredClone(fixture("status-staging.json")) as Record<string, any>;
    for (const m of old.members) delete m.featureFlags;
    expect(flagsFromStatus(old)).toBeNull();
    const unread = structuredClone(fixture("status-staging.json")) as Record<string, any>;
    unread.members[0].featureFlags = null;
    expect(flagsFromStatus(unread)).toEqual({ flags: [], unreadable: ["web"] });
  });
  it("names a value's state, and finds a parameter's move only on its own path", () => {
    expect([true, false, undefined, "blue", 3].map((v) => flagState(v as never))).toEqual(["on", "off", "default", "set", "set"]);
    expect(paramMoves(fixture("change-set-show.json"), "banner")).toBeNull();
    expect(turnOnLines({ id: "a", kind: "k.mjs", path: "a.flag.md", values: { prod: "it's" } }, "dev")[0]).toContain(`'{"values":{"prod":"it'\\''s","dev":true}}'`);
  });
});

describe("readFeatureFlags (#683)", () => {
  const ws: Workspace = { name: "acme", root: "/ws", file: "chant.workspace.json", chant: "0.124.29", members: [{ name: "web", dir: "web", kind: "chant" } as Workspace["members"][number]] };
  it("reads status per environment and the waiting gate's change set, through the reader", async () => {
    const calls: string[][] = [];
    const reader = workspaceReader({
      run: async (argv) => {
        calls.push(argv);
        const doc = argv[0] === "change-set" ? fixture("change-set-show.json") : fixture(`status-${argv[2]}.json`);
        return { status: 0, stdout: JSON.stringify(doc), stderr: "" };
      },
    });
    const read = await readFeatureFlags(ws, { env: "staging", reader, now: () => AT });
    if (!read.ok) throw new Error(read.refusal.error);
    expect(calls).toEqual([
      ["workspace", "status", "staging", "--json"],
      ["workspace", "status", "prod", "--json"],
      ["change-set", "show", DIGEST, "--member", "web", "--json"],
    ]);
    expect(read.flags).toEqual(answer());
  });
  it("refuses a status with no featureFlags, naming the chant that adds them", async () => {
    const old = structuredClone(fixture("status-staging.json")) as Record<string, any>;
    for (const m of old.members) delete m.featureFlags;
    const reader = workspaceReader({ run: async () => ({ status: 0, stdout: JSON.stringify(old), stderr: "" }) });
    const read = await readFeatureFlags(ws, { env: "staging", reader });
    expect(read).toMatchObject({ ok: false, refusal: { code: "no-feature-flags", remedy: expect.stringContaining("0.124.29") } });
  });
});

// The route over the app, with a project chant that answers from the fixtures.
describe("GET /api/workspace/flags (#683)", () => {
  const made: string[] = [];
  afterAll(() => {
    setServedWorkspace(undefined);
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  function root(version: string): string {
    const dir = mkdtempSync(join(tmpdir(), "behold-683-flags-"));
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
const fix = ${JSON.stringify(FIX)};
const argv = process.argv.slice(2);
appendFileSync(join(__dirname, "calls"), JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
const line = argv.join(" ");
const print = (name) => process.stdout.write(readFileSync(join(fix, name), "utf8"));
if (line === "workspace status staging --json") print("status-staging.json");
else if (line === "workspace status prod --json") print("status-prod.json");
else if (line === ${JSON.stringify(`change-set show ${DIGEST} --member web --json`)}) print("change-set-show.json");
else { process.stderr.write("unexpected " + line); process.exit(2); }
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

  it("answers the flags with their marks, the waiting flip and the lines to turn one on", async () => {
    const app = serve(root("0.124.29"));
    const res = await app.request("/api/workspace/flags");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.refusal).toBeUndefined();
    expect(body.chant).toBe("0.124.29");
    expect(body.environments).toEqual(["staging", "prod"]);
    const f = body.flags.find((x: any) => x.id === "new-checkout");
    expect(f.envs).toEqual({ staging: { value: true, state: "on" }, prod: { value: false, state: "off" } });
    expect(f.waiting[0]).toMatchObject({ env: "staging", gate: GATE, changeSet: DIGEST });
    expect(body.flags.find((x: any) => x.id === "old-banner").stale).toBe(true);
  });

  it("refuses on a chant below the floor without spawning it, and says what is degraded", async () => {
    const dir = root("0.124.28");
    const app = serve(dir);
    const body = (await (await app.request("/api/workspace/flags")).json()) as Record<string, any>;
    expect(body.refusal).toMatchObject({ code: "chant-too-old" });
    expect(body.degraded).toMatch(/no flag marks/);
    expect(existsSync(join(dir, "node_modules", "@intentius", "chant", "bin", "calls"))).toBe(false);
  });

  it("offers no write: there is no flag route but the read", () => {
    const app = serve(root("0.124.29"));
    const flagRoutes = app.routes.filter((r) => r.path.includes("flag"));
    expect(flagRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/workspace/flags"]);
  });

  it("is refused in a public view, as the lane is", () => {
    expect(publicReadRefusal("/api/workspace/flags", new URLSearchParams())).toBeDefined();
  });
});
