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
import { CHANGE_SET_SHOW_CHANT_FLOOR, CHANT_FLOORS, floorFor } from "./chant-floors.ts";
import { gatesFromStatus } from "./workspace-gates.ts";
import { overlayFloorRefusal, overlayFrom, readChangeSetOverlay, showRefusal } from "./change-set-overlay.ts";
import { workspaceReader, type WorkspaceDocument } from "./workspace-reader.ts";
import { choudoufuCardAliases } from "./drift-overlay.ts";
import { publicReadRefusal } from "./public-mode.ts";
import showSchema from "./trunk-lane-schemas/change-set-show.schema.json" with { type: "json" };
import changeSetSchema from "./trunk-lane-schemas/change-set.schema.json" with { type: "json" };
import statusSchema from "./trunk-lane-schemas/status.schema.json" with { type: "json" };

// #681. The fixtures are what chant main at 509acfa (0.124.28's code, which
// still calls itself 0.124.27) printed for a throwaway workspace: member `web`
// promoting staging then prod, and a release gate (op `release`, gate
// `promote`) waiting in prod on commit a14610e, binding a change set planned
// for release 1a23268fa8b1 in prod. The change set was composed with chant's
// own composeChangeSet, so its digest is chant's, and stored on chant/lifecycle
// with each entry's node: a create, an update, a replace, a no-op, and a
// delete of a block the planning commit no longer declares (`node: null`).
// The schemas in src/trunk-lane-schemas/ are chant's, from the same commit.
// status.schema.json was refreshed from chant main at 0689d28f0 for #683,
// which only adds featureFlags.

const FIX = join(import.meta.dirname, "__fixtures__", "change-set-overlay");
const fixture = (name: string): WorkspaceDocument => JSON.parse(readFileSync(join(FIX, name), "utf8")) as WorkspaceDocument;
const DIGEST = "jcs1-sha256:9cf74a6fee021fb5775b684f76149d3e14a901574e7685471dd3e7987b16f66e";
const RELEASE = "jcs1-sha256:1a23268fa8b1fc419cffde4c1780f4387ff0346495f97bd9e22b0508bef99f9d";
const C2 = "a14610e4f51778c969efcc77694a360412c34d88";
const KEY = "web/release/promote";

function gate() {
  const read = gatesFromStatus(fixture("status-prod.json"), "/ws");
  if (!read.ok) throw new Error(read.refusal.error);
  const { dir: _dir, ...g } = read.gates.find((x) => x.key === KEY)!;
  return g;
}

describe("the recorded documents are chant's (#681)", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  it.each([
    ["change-set-show.json", showSchema],
    ["change-set-missing.json", showSchema],
    ["status-prod.json", statusSchema],
  ])("%s validates against chant's schema", (name, schema) => {
    const validate = ajv.compile(schema);
    expect(validate(fixture(name)), JSON.stringify(validate.errors)).toBe(true);
  });
  it("the stored change set validates against chant's change-set schema", () => {
    const validate = ajv.compile(changeSetSchema);
    expect(validate(fixture("change-set-show.json").changeSet), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("the overlay's floor (#681, #691)", () => {
  it("registers the change-set read at 0.124.28", () => {
    expect(CHANGE_SET_SHOW_CHANT_FLOOR).toBe("0.124.28");
    expect(CHANT_FLOORS).toContain(floorFor("change set"));
  });
  it("refuses a chant below it, and passes one at it", () => {
    expect(overlayFloorRefusal("0.124.24")).toMatchObject({ code: "chant-too-old" });
    expect(overlayFloorRefusal("0.124.28")).toBeUndefined();
  });
});

describe("overlayFrom (#681)", () => {
  it("keys the stored change set by graph node, in create, change and delete", () => {
    const o = overlayFrom(gate(), fixture("change-set-show.json"), new Date("2026-10-16T00:00:00Z"));
    expect(o.digest).toBe(DIGEST);
    expect(o.gate).toMatchObject({ key: KEY, op: "release", gate: "promote", env: "prod", gitSha: C2, runId: "run-9", releaseDigest: RELEASE });
    expect(o.planned).toEqual({ releaseDigest: RELEASE, environment: "prod" });
    expect(o.graph).toEqual({ member: "web", at: C2 });
    expect(o.nodes).toEqual({
      "web/AppBucket": { bucket: "change", actions: { update: 1 } },
      "web/AppFunction": { bucket: "change", actions: { replace: 1 } },
      "web/AppQueue": { bucket: "create", actions: { create: 1 } },
    });
    expect(o.counts).toEqual({ create: 1, change: 2, delete: 1 });
    expect(o.unchanged).toBe(1);
    expect(o.gaps).toEqual([]);
  });
  it("keeps an entry chant mapped to no node, rather than dropping it", () => {
    const o = overlayFrom(gate(), fixture("change-set-show.json"), new Date());
    expect(o.entries.filter((e) => e.node === null)).toEqual([
      { member: "web", address: "LegacyTopic", type: "AWS::SNS::Topic", action: "delete", bucket: "delete", node: null, disruption: "destroy", deposed: null, attributes: [] },
    ]);
  });
  it("carries each entry's fields, and never a sensitive value", () => {
    const o = overlayFrom(gate(), fixture("change-set-show.json"), new Date());
    const fn = o.entries.find((e) => e.address === "AppFunction")!;
    expect(fn.attributes).toEqual([
      { path: "FunctionName", before: "cart-v1", after: "cart-v2", forcesReplacement: true },
      { path: "Environment", sensitive: true },
    ]);
    const bucket = o.entries.find((e) => e.address === "AppBucket")!;
    expect(bucket.attributes.find((a) => a.path === "Tags")).toMatchObject({ unknown: true });
  });
  it("lets the strongest action colour a card with several, and names a member that failed to plan", () => {
    const doc = fixture("change-set-show.json") as any;
    const cs = structuredClone(doc);
    cs.changeSet.entries.push({ ...cs.changeSet.entries.find((e: any) => e.address === "AppQueue"), address: "AppQueueOld", action: "delete" });
    cs.changeSet.members.push({ member: "api", lexicon: "aws", planner: "chant", status: "failed", error: "no credentials", planDigest: null, holes: [] });
    const o = overlayFrom(gate(), cs, new Date());
    expect(o.nodes["web/AppQueue"]).toEqual({ bucket: "delete", actions: { create: 1, delete: 1 } });
    expect(o.gaps).toEqual([{ member: "api", status: "failed", error: "no credentials", holes: [] }]);
  });
  it("refuses a digest with nothing stored under it, in chant's words", () => {
    expect(showRefusal(fixture("change-set-missing.json"), "sha256:" + "0".repeat(64), "web")).toMatchObject({ code: "no-change-set" });
    expect(showRefusal(fixture("change-set-show.json"), DIGEST, "web")).toBeUndefined();
    expect(showRefusal({ contract: 1, error: { code: "ledger-unreadable", message: "reading the change set failed: boom" } }, DIGEST, "web")).toMatchObject({ code: "ledger-unreadable" });
  });
});

describe("readChangeSetOverlay (#681)", () => {
  const ws: Workspace = { name: "acme", root: "/ws", file: "chant.workspace.json", chant: "0.124.28", members: [{ name: "web", dir: "web", kind: "chant" } as Workspace["members"][number]] };
  function transport() {
    const calls: string[][] = [];
    return {
      calls,
      run: async (argv: string[]) => {
        calls.push(argv);
        const doc = argv[0] === "workspace" ? fixture("status-prod.json") : fixture("change-set-show.json");
        return { status: 0, stdout: JSON.stringify(doc), stderr: "" };
      },
    };
  }
  it("reads status for the gate, then the change set it binds in its member, through the reader", async () => {
    const t = transport();
    const read = await readChangeSetOverlay(ws, { key: KEY, env: "prod", reader: workspaceReader(t) });
    expect(read.ok).toBe(true);
    expect(t.calls).toEqual([
      ["workspace", "status", "prod", "--json"],
      ["change-set", "show", DIGEST, "--member", "web", "--json"],
    ]);
  });
  it("answers 404 for a gate that is not waiting, and reads no change set", async () => {
    const t = transport();
    const read = await readChangeSetOverlay(ws, { key: "web/web/promote", env: "prod", reader: workspaceReader(t) });
    expect(read).toMatchObject({ ok: false, status: 404, refusal: { code: "no-gate" } });
    expect(t.calls).toHaveLength(1);
  });
  it("names the change-set read by its own command when chant writes another contract", async () => {
    const reader = workspaceReader({ run: async () => ({ status: 0, stdout: JSON.stringify({ contract: 2 }), stderr: "" }) });
    await expect(reader.readChangeSet(DIGEST, "web")).rejects.toThrow(/chant change-set show wrote a document with contract 2/);
  });
});

// The route over the app, with a project chant that answers from the fixtures.
describe("GET /api/workspace/change-set (#681)", () => {
  const made: string[] = [];
  afterAll(() => {
    setServedWorkspace(undefined);
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  function root(version: string): string {
    const dir = mkdtempSync(join(tmpdir(), "behold-681-cs-"));
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
if (line === "workspace status prod --json") print("status-prod.json");
else if (line === ${JSON.stringify(`change-set show ${DIGEST} --member web --json`)}) print("change-set-show.json");
else { process.stderr.write("unexpected " + line); process.exit(2); }
`,
    );
    chmodSync(bin, 0o755);
    return dir;
  }

  const serve = (dir: string) => {
    const w: Workspace = { name: "acme", root: dir, file: "chant.workspace.json", chant: "0.124.28", members: [{ name: "web", dir: "web", kind: "chant" } as Workspace["members"][number]] };
    setServedWorkspace(w);
    const broadcaster = new Broadcaster();
    return createApp({ projectDir: dir, workspace: w, port: 0, env: "prod" }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
  };

  it("answers the overlay for a waiting release gate, from the stored change set", async () => {
    const app = serve(root("0.124.28"));
    const res = await app.request(`/api/workspace/change-set?gate=${encodeURIComponent(KEY)}&env=prod`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.refusal).toBeUndefined();
    expect(body.gate).toMatchObject({ key: KEY, gitSha: C2, releaseDigest: RELEASE });
    expect(Object.keys(body.nodes).sort()).toEqual(["web/AppBucket", "web/AppFunction", "web/AppQueue"]);
    expect(body.entries.map((e: any) => [e.address, e.node])).toContainEqual(["LegacyTopic", null]);
    // The member's directory stays on the server.
    expect(body.gate.dir).toBeUndefined();
  });

  it("refuses a malformed gate or env before reading anything", async () => {
    const dir = root("0.124.28");
    const app = serve(dir);
    expect((await app.request("/api/workspace/change-set?gate=web&env=prod")).status).toBe(400);
    expect((await app.request(`/api/workspace/change-set?gate=${encodeURIComponent(KEY)}&env=${encodeURIComponent("prod; rm")}`)).status).toBe(400);
    expect(existsSync(join(dir, "node_modules", "@intentius", "chant", "bin", "calls"))).toBe(false);
  });

  it("refuses on a chant below the floor without spawning it", async () => {
    const dir = root("0.124.24");
    const app = serve(dir);
    const body = (await (await app.request(`/api/workspace/change-set?gate=${encodeURIComponent(KEY)}&env=prod`)).json()) as Record<string, any>;
    expect(body.refusal).toMatchObject({ code: "chant-too-old" });
    expect(existsSync(join(dir, "node_modules", "@intentius", "chant", "bin", "calls"))).toBe(false);
  });

  it("is refused in a public view, as the lane is", () => {
    expect(publicReadRefusal("/api/workspace/change-set", new URLSearchParams())).toBeDefined();
    expect(publicReadRefusal("/api/workspace/lane", new URLSearchParams())).toBeDefined();
  });
});

describe("a choudoufu gate's entries land on behold's card ids (behold#995, the B3 follow-up)", () => {
  it("maps chant's <member>/<root>/<path> through the member's alias table onto the roster card the address names", () => {
    const aliases = choudoufuCardAliases("azure", {
      nodes: [{ id: "azure/module.site/azurerm_storage_account.sa", kind: "x", lexicon: "x", attrs: { root: "azure" } }] as never,
    });
    const shown: WorkspaceDocument = {
      changeSet: {
        digest: "d",
        entries: [
          { member: "azure", address: 'module.site["a"].azurerm_storage_account.sa', type: "azurerm_storage_account", action: "update", node: "azure/azure/module.site/azurerm_storage_account.sa" },
          { member: "azure", address: "azurerm_key_vault.kv", type: "azurerm_key_vault", action: "create", node: "azure/azure/azurerm_key_vault.kv" },
        ],
      },
    };
    const o = overlayFrom({ ...gate(), member: "azure" }, shown, new Date(), aliases);
    expect(o.nodes['azure/module.site["a"].azurerm_storage_account.sa']).toEqual({ bucket: "change", actions: { update: 1 } });
    // A node the table does not know keeps chant's id: it outlines nothing and is still listed.
    expect(o.entries.find((e) => e.address === "azurerm_key_vault.kv")!.node).toBe("azure/azure/azurerm_key_vault.kv");
  });
});
