// #825: runtime health and rotation.
//
// The fixtures in src/__fixtures__/health/ were recorded from chant main at
// cd9a90716 (chant PR #4188), packed locally as 0.124.33, against a private
// floci whose Route 53 health checks probe their endpoint (lex00/floci#259):
//
// - dns-health.json: the #823 prototype's `dns` member, applied to floci with
//   the AWS and GCP checks pointed at hosts that answer and the Azure check at
//   one that does not resolve, so azureCheck is unhealthy for real.
// - ecs-health.json: a small project with one ECS service running and one
//   scaled to zero (healthy and unknown).
// - dns-unobserved.json: the same `dns` member with the endpoint pointed at a
//   closed port, so every check is a read-failed hole.
// - azure-health.json, gcp-health.json: the prototype's other members with no
//   emulator behind them (read-failed, no-binding).
// - dns-graph-ir.json: `chant graph src --format ir --detail 2` of the `dns`
//   member, the edges rotation reads.
// - stacks-health.json (#824): the three-cloud example's `aws` member, which
//   declares `stacks`, recorded from chant main at b25ce7d0d against
//   ghcr.io/lex00/floci:1564bbe with its stack rolled back (lex00/floci#261),
//   so the service is absent.
//
// The other multi-stack and malformed documents below are hand-built, in the shape
// chant's schema (src/health-schema/health.schema.json) states.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { setServedWorkspace, type Workspace } from "./workspace.ts";
import { CHANT_FLOORS, floorFor, HEALTH_CHANT_FLOOR } from "./chant-floors.ts";
import { healthArgv, healthDocumentOf, workspaceReader, WorkspaceReadError } from "./workspace-reader.ts";
import { HEALTH_SCHEMA_ID, healthProblems, nodeHealthOf, recordChecks, rotationOf, type HealthDocument, type RotationGraph } from "./runtime-health.ts";
import { HEALTH_READ_NAME, invalidateHealth, readHealthOverlay } from "./health-overlay.ts";
import { publicReadRefusal } from "./public-mode.ts";
import { captureKeys } from "./export.ts";
import healthSchema from "./health-schema/health.schema.json" with { type: "json" };

const FIX = join(import.meta.dirname, "__fixtures__", "health");
const fixture = (name: string): HealthDocument => JSON.parse(readFileSync(join(FIX, name), "utf8")) as HealthDocument;
const dnsGraph = (): RotationGraph => JSON.parse(readFileSync(join(FIX, "dns-graph-ir.json"), "utf8")) as RotationGraph;

/** A copy of the dns fixture with each check's state set by hand. */
function dnsWith(states: Record<string, "healthy" | "unhealthy" | "unknown">): HealthDocument {
  const doc = structuredClone(fixture("dns-health.json"));
  for (const [name, state] of Object.entries(states)) doc.lexicons!.aws.entities[name].state = state;
  return doc;
}

describe("the chant-health/v1 document (#825)", () => {
  it("vendors chant's schema unchanged and keys on schema, not a contract", () => {
    expect(HEALTH_SCHEMA_ID).toBe("https://intentius.io/chant/schemas/health/v1/health.schema.json");
    expect(healthSchema.properties.schema.const).toBe("chant-health/v1");
  });

  it("accepts every recorded document", () => {
    for (const f of ["dns-health.json", "ecs-health.json", "dns-unobserved.json", "azure-health.json", "gcp-health.json"]) expect(healthProblems(fixture(f)), f).toEqual([]);
  });

  it("accepts a multi-stack document and a hole with a reason chant may add later", () => {
    const doc = fixture("ecs-health.json") as unknown as Record<string, any>;
    const { lexicons, ...rest } = doc;
    const stacked = { ...rest, stacks: { "aws-prod": lexicons } };
    expect(healthProblems(stacked)).toEqual([]);
    const hole = structuredClone(fixture("azure-health.json")) as Record<string, any>;
    hole.lexicons.azure.unobserved.app.reason = "rate-limited";
    expect(healthProblems(hole)).toEqual([]);
  });

  it("refuses a state outside healthy, unhealthy and unknown, both lexicons and stacks, and a missing summary", () => {
    const bad = structuredClone(fixture("dns-health.json")) as Record<string, any>;
    bad.lexicons.aws.entities.awsCheck.state = "degraded";
    expect(healthProblems(bad).join(" ")).toMatch(/state/);
    const both = { ...fixture("dns-health.json"), stacks: {} };
    expect(healthProblems(both)).not.toEqual([]);
    const noSummary = structuredClone(fixture("dns-health.json")) as Record<string, any>;
    delete noSummary.summary;
    expect(healthProblems(noSummary).join(" ")).toMatch(/summary/);
  });

  it("is read once per project through the reader, and refused whole when it does not fit", async () => {
    const calls: Array<{ argv: string[]; dir?: string }> = [];
    const text = readFileSync(join(FIX, "dns-health.json"), "utf8");
    const reader = workspaceReader({ run: async (argv, o) => (calls.push({ argv, dir: o?.dir }), { status: 0, stdout: text, stderr: "" }) });
    const doc = await reader.readHealth("prod", "dns");
    expect(doc.environment).toBe("prod");
    expect(calls).toEqual([{ argv: ["lifecycle", "health", "prod", "--json"], dir: "dns" }]);
    expect(healthArgv("prod")).toEqual(["lifecycle", "health", "prod", "--json"]);
    const refused = (stdout: string, stderr = "", status = 0) => {
      try {
        healthDocumentOf({ status, stdout, stderr }, "chant lifecycle health prod --json");
        return undefined;
      } catch (e) {
        return (e as WorkspaceReadError).refusal;
      }
    };
    expect(refused(JSON.stringify({ ...JSON.parse(text), schema: "chant-health/v2" }))?.code).toBe("health-schema");
    expect(refused("", "warning: No configured lexicon has a health read (aws, azure and gcp do)", 1)?.code).toBe("health-none");
    expect(refused("", "boom", 1)?.code).toBe("lifecycle-health");
    expect(refused(JSON.stringify({ ...JSON.parse(text), lexicons: {} }), "Build failed for project", 1)?.code).toBe("lifecycle-health");
  });
});

describe("node health and rotation (#825)", () => {
  it("composes member ids and keeps holes apart from verdicts", () => {
    const nodes = { ...nodeHealthOf(fixture("dns-health.json"), "dns"), ...nodeHealthOf(fixture("azure-health.json"), "azure") };
    expect(nodes["dns/azureCheck"]).toMatchObject({ state: "unhealthy", type: "AWS::Route53::HealthCheck", checkedAt: "2026-10-21T04:48:42.977269840Z" });
    expect(nodes["dns/awsCheck"].state).toBe("healthy");
    expect(nodes["azure/app"]).toEqual({ state: "unobserved", reason: "read-failed", type: "Microsoft.App/containerApps", detail: "fetch failed" });
    expect(nodeHealthOf(fixture("ecs-health.json")).idle.state).toBe("unknown");
  });

  // #824: stacks-health.json is the three-cloud aws member, which declares
  // `stacks`, read against floci with its stack rolled back. Its live overlay
  // names the service `aws/three-cloud-aws::webService`, so its health does too.
  it("keys a multi-stack document's nodes by stack, the way the live overlay names them", () => {
    expect(nodeHealthOf(fixture("stacks-health.json"), "aws")).toEqual({ "aws/three-cloud-aws::webService": { state: "absent" } });
    expect(nodeHealthOf(fixture("stacks-health.json"))).toEqual({ "three-cloud-aws::webService": { state: "absent" } });
  });

  it("finds each record's check from the HealthCheckId edge, and from the attribute when there is no edge", () => {
    const g = dnsGraph();
    expect(Object.fromEntries(recordChecks(g))).toEqual({
      awsRecord: { check: "awsCheck", declared: true },
      azureRecord: { check: "azureCheck", declared: true },
      gcpRecord: { check: "gcpCheck", declared: true },
    });
    const noEdges = { ...g, edges: [] };
    expect(recordChecks(noEdges).get("azureRecord")).toEqual({ check: "azureCheck", declared: true });
    const literal = { nodes: [{ id: "r", kind: "AWS::Route53::RecordSet", attrs: { HealthCheckId: "abcd-1234" } }], edges: [] };
    expect(rotationOf(literal, {})).toMatchObject({ r: { inRotation: null, line: "rotation unknown: health check abcd-1234 is not declared here" } });
  });

  it("takes a record out of rotation only when its check is unhealthy", () => {
    const rotation = rotationOf(dnsGraph(), nodeHealthOf(fixture("dns-health.json"), "dns"), "dns");
    expect(rotation["dns/azureRecord"]).toEqual({ record: "dns/azureRecord", check: "dns/azureCheck", checkState: "unhealthy", inRotation: false, line: "out of rotation: azureCheck unhealthy" });
    expect(rotation["dns/awsRecord"].inRotation).toBe(true);
    expect(rotation["dns/gcpRecord"].line).toBe("in rotation: gcpCheck healthy");
  });

  it("says unknown, never out, for a check that is unknown, unread, absent or missing", () => {
    expect(rotationOf(dnsGraph(), nodeHealthOf(dnsWith({ azureCheck: "unknown" })))["azureRecord"]).toMatchObject({ inRotation: null, line: "rotation unknown: azureCheck unknown" });
    const unread = rotationOf(dnsGraph(), nodeHealthOf(fixture("dns-unobserved.json")));
    expect(Object.values(unread).map((r) => [r.inRotation, r.line])).toEqual([
      [null, "rotation unknown: awsCheck not read"],
      [null, "rotation unknown: azureCheck not read"],
      [null, "rotation unknown: gcpCheck not read"],
    ]);
    expect(rotationOf(dnsGraph(), { azureCheck: { state: "absent" } })["azureRecord"].line).toBe("rotation unknown: azureCheck not deployed");
    expect(rotationOf(dnsGraph(), {})["azureRecord"].line).toBe("rotation unknown: no health read for azureCheck");
  });
});

describe("readHealthOverlay (#825)", () => {
  const docs: Record<string, string> = { "/ws/dns": "dns-health.json", "/ws/azure": "azure-health.json" };
  const deps = (versions: Record<string, string> = {}) => ({
    chantVersion: (dir: string) => versions[dir] ?? HEALTH_CHANT_FLOOR,
    reader: (dir: string) =>
      workspaceReader({ run: async () => (docs[dir] ? { status: 0, stdout: readFileSync(join(FIX, docs[dir]), "utf8"), stderr: "" } : { status: 1, stdout: "", stderr: "No configured lexicon has a health read" }) }),
    graph: async (dir: string) => (dir === "/ws/dns" ? dnsGraph() : { nodes: [], edges: [] }),
    now: () => new Date("2026-10-21T05:00:00Z"),
  });

  it("reads each member, composes ids, derives rotation and counts", async () => {
    const a = await readHealthOverlay([{ name: "dns", dir: "/ws/dns" }, { name: "azure", dir: "/ws/azure" }, { name: "gcp", dir: "/ws/gcp" }], "prod", deps());
    expect(a.counts).toEqual({ healthy: 2, unhealthy: 1, unknown: 0, unobserved: 1, absent: 0, outOfRotation: 1 });
    expect(a.rotation["dns/azureRecord"].inRotation).toBe(false);
    expect(a.members.map((m) => [m.member, !!m.refusal, !!m.none])).toEqual([["dns", false, false], ["azure", false, false], ["gcp", false, true]]);
    expect(a.refusal).toBeUndefined();
  });

  it("refuses a member below the floor without reading it, and the whole answer when every member is", async () => {
    let spawned = 0;
    const d = { ...deps({ "/ws/dns": "0.124.32" }), reader: (dir: string) => (spawned++, deps().reader(dir)) };
    const a = await readHealthOverlay([{ name: "dns", dir: "/ws/dns" }], "prod", d);
    expect(spawned).toBe(0);
    expect(a.refusal).toMatchObject({ code: "chant-too-old" });
    expect(a.degraded).toBe(floorFor(HEALTH_READ_NAME).degraded);
    expect(a.nodes).toEqual({});
  });

  it("registers its floor", () => {
    expect(CHANT_FLOORS.find((f) => f.read === HEALTH_READ_NAME)?.floor).toBe("0.124.33");
  });
});

describe("GET /api/health (#825)", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  beforeEach(() => invalidateHealth());

  function root(version: string): string {
    const dir = mkdtempSync(join(tmpdir(), "behold-825-"));
    made.push(dir);
    for (const m of ["dns", "azure"]) mkdirSync(join(dir, m));
    const pkg = join(dir, "node_modules", "@intentius", "chant");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/chant", version, main: "index.js", bin: { chant: "bin/chant" } }));
    writeFileSync(join(pkg, "index.js"), "");
    const bin = join(pkg, "bin", "chant");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const { readFileSync, appendFileSync } = require("node:fs");
const { join, basename } = require("node:path");
const argv = process.argv.slice(2);
const member = basename(process.cwd());
appendFileSync(join(__dirname, "calls"), JSON.stringify({ argv, member }) + "\\n");
const FIX = ${JSON.stringify(FIX)};
if (argv.join(" ") === "lifecycle health prod --json") process.stdout.write(readFileSync(join(FIX, member === "dns" ? "dns-health.json" : "azure-health.json"), "utf8"));
else if (argv[0] === "graph") process.stdout.write(member === "dns" ? readFileSync(join(FIX, "dns-graph-ir.json"), "utf8") : JSON.stringify({ version: 1, nodes: [], edges: [], groups: {} }));
else { process.stderr.write("unexpected " + argv.join(" ")); process.exit(2); }
`,
    );
    chmodSync(bin, 0o755);
    return dir;
  }

  const serve = (dir: string) => {
    const members = ["dns", "azure"].map((name) => ({ name, dir: name, kind: "chant", abs: join(dir, name), reason: null, because: null }));
    const w: Workspace = { name: "three-cloud", root: dir, file: "chant.workspace.json", chant: "0.124.33", members };
    setServedWorkspace(w);
    const broadcaster = new Broadcaster();
    return createApp({ projectDir: join(dir, "dns"), projectDirs: members.map((m) => m.abs), workspace: w, port: 0 }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
  };
  const calls = (dir: string) => {
    const f = join(dir, "node_modules", "@intentius", "chant", "bin", "calls");
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; member: string }) : [];
  };
  const healthCalls = (dir: string) => calls(dir).filter((c) => c.argv[0] === "lifecycle");

  it("answers each member's health under composed ids, with the Azure record out of rotation", async () => {
    const dir = root("0.124.33");
    const res = await serve(dir).request("/api/health?env=prod");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.nodes["dns/azureCheck"].state).toBe("unhealthy");
    expect(body.nodes["azure/app"]).toMatchObject({ state: "unobserved", reason: "read-failed" });
    expect(body.rotation["dns/azureRecord"]).toMatchObject({ inRotation: false, line: "out of rotation: azureCheck unhealthy" });
    expect(body.rotation["dns/awsRecord"].inRotation).toBe(true);
    expect(healthCalls(dir).map((c) => c.member).sort()).toEqual(["azure", "dns"]);
  });

  it("serves a second ask from its cache, and reads again with ?fresh=1", async () => {
    const dir = root("0.124.33");
    const app = serve(dir);
    await app.request("/api/health?env=prod");
    const again = (await (await app.request("/api/health?env=prod")).json()) as Record<string, any>;
    expect(again.cached).toBe(true);
    expect(healthCalls(dir)).toHaveLength(2);
    await app.request("/api/health?env=prod&fresh=1");
    expect(healthCalls(dir)).toHaveLength(4);
  });

  it("refuses below the floor without spawning, and needs an env", async () => {
    const dir = root("0.124.32");
    const body = (await (await serve(dir).request("/api/health?env=prod")).json()) as Record<string, any>;
    expect(body.refusal).toMatchObject({ code: "chant-too-old" });
    expect(body.degraded).toMatch(/no health marks/);
    expect(calls(dir)).toEqual([]);
    expect((await serve(root("0.124.33")).request("/api/health")).status).toBe(400);
  });

  it("is a GET only, refused in a public view, and captured once per environment by an export", () => {
    const app = serve(root("0.124.33"));
    expect(app.routes.filter((r) => r.path === "/api/health").map((r) => r.method)).toEqual(["GET"]);
    expect(publicReadRefusal("/api/health", new URLSearchParams("env=prod"))).toBeDefined();
    const keys = captureKeys({ environments: ["prod", "staging"] });
    expect(keys.filter((k) => k.startsWith("/api/health"))).toEqual(["/api/health?env=prod", "/api/health?env=staging"]);
  });
});
