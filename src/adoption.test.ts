import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  ADOPTION_WAITS,
  adoptionReportOf,
  adoptionRoutes,
  promoteApproveLine,
  promoteStartArgv,
  RECORDED_NOTE,
  stateFileFor,
  type SpawnChant,
} from "./adoption.ts";
import { ADOPTION_REPORT_CHANT_FLOOR, CHANT_FLOORS, floorFor } from "./chant-floors.ts";
import { Broadcaster } from "./events.ts";
import { OpRunner } from "./op-runner.ts";
import { publicReadRefusal } from "./public-mode.ts";
import type { Workspace } from "./workspace.ts";
import { promoteReportArgv, PROMOTE_REPORT_READ, workspaceReader, WorkspaceReadError, type WorkspaceDocument } from "./workspace-reader.ts";

// behold#999. A workspace with a terraform root that has a state file, one
// that has none, a Pulumi stack (adoption waits on plunge P-L4) and a chant
// member (never offered).
function workspace(): { ws: Workspace; root: string } {
  const root = mkdtempSync(join(tmpdir(), "behold-adopt-"));
  for (const d of ["net", "edge", "stack", "app"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "net", "terraform.tfstate"), JSON.stringify({ version: 4, resources: [] }));
  const m = (name: string, kind: string) => ({ name, dir: name, kind, abs: join(root, name), reason: null, because: null });
  return { root, ws: { name: "w", root, file: "chant.workspace.json", chant: ADOPTION_REPORT_CHANT_FLOOR, members: [m("net", "terraform"), m("edge", "terraform"), m("stack", "pulumi"), m("app", "chant")] } };
}

const ENTRIES = [
  { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", status: "VERIFIED", liveId: "net-logs", detail: "The live object matches the state's recorded attributes.", claimed: true },
  { address: "aws_vpc.main", type: "aws_vpc", status: "DRIFTED", liveId: "vpc-1", detail: "The live object differs: cidr_block.", claimed: true },
  { address: "aws_s3_bucket.gone", type: "aws_s3_bucket", status: "MISSING", liveId: null, detail: "The live system reports that this identity no longer exists.", claimed: false },
  { address: "aws_s3_bucket_versioning.logs", type: "aws_s3_bucket_versioning", status: "UNTAGGABLE", liveId: "net-logs", detail: "no tags argument", claimed: false },
  { address: "aws_kms_alias.a", type: "aws_kms_alias", status: "UNADMITTED_TYPE", liveId: "alias/a", detail: "no identity knowledge", claimed: false },
];
const doc = (outcome: string, extra: Record<string, unknown> = {}): WorkspaceDocument => ({
  outcome,
  member: "net",
  from: "terraform",
  to: "choudoufu",
  digest: "sha256:abc",
  ran: [],
  adoption: { estate: "net", state: "/s", entries: ENTRIES, claimed: 2, total: 5 },
  ...extra,
});

function served({ version = ADOPTION_REPORT_CHANT_FLOOR, preview = false, recorded, exit = 3, hold = false }: { version?: string; preview?: boolean; recorded?: string; exit?: number; hold?: boolean } = {}) {
  const { ws, root } = workspace();
  const broadcaster = new Broadcaster();
  const said: string[] = [];
  broadcaster.subscribe((type, data) => type === "op" && said.push(data));
  const runner = new OpRunner({ projectDir: root, broadcaster, onDone: () => {} });
  const reads: { root: string; member: string; state: string }[] = [];
  const spawned: { args: string[]; cwd: string }[] = [];
  let release: (code: number) => void = () => {};
  const spawn: SpawnChant = (args, cwd, out) => {
    spawned.push({ args, cwd });
    out(JSON.stringify(doc(exit === 3 ? "gated" : exit === 0 ? "applied" : "checks-failed", exit === 1 ? { failed: { label: "choudoufu live-check", output: "x" } } : {})));
    return { done: hold ? new Promise<number>((r) => (release = r)) : Promise.resolve(exit) };
  };
  const app = new Hono();
  adoptionRoutes(app, {
    workspace: () => ws,
    runner,
    broadcaster,
    readReport: async (r, member, state) => (reads.push({ root: r, member, state }), doc("dry-run")),
    preview: () => preview,
    recorded: () => recorded,
    chantVersion: () => version,
    spawn,
  });
  const post = (body: unknown) => app.request("/api/adopt/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = async (url: string) => {
    const r = await app.request(url);
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  return { app, post, get, root, reads, spawned, said, runner, release: (c: number) => release(c) };
}

describe("what adoption offers (behold#999)", () => {
  it("offers each terraform member to choudoufu with what it gains, its limits and the command; Pulumi waits on P-L4; a chant member is not listed", async () => {
    const s = served();
    const { body } = await s.get("/api/adopt");
    expect(body.refusal).toBeNull();
    const by = Object.fromEntries((body.offers as Record<string, any>[]).map((o) => [o.member, o]));
    expect(Object.keys(by).sort()).toEqual(["edge", "net", "stack"]);
    expect(by.net).toMatchObject({ kind: "terraform", engine: "choudoufu", offered: true, state: { file: "terraform.tfstate", present: true }, start: { offered: true } });
    expect(by.net.command).toBe(`chant workspace promote net --state ${join(s.root, "net", "terraform.tfstate")}`);
    expect(by.net.approve).toBe("chant approve workspace-promote net");
    expect(by.net.gains.join(" ")).toMatch(/marker tags/);
    expect(by.net.limits.join(" ")).toMatch(/MISSING, UNTAGGABLE and UNADMITTED_TYPE/);
    expect(by.edge.start).toMatchObject({ offered: false, why: expect.stringMatching(/no terraform\.tfstate in edge/) });
    expect(by.stack).toEqual({ member: "stack", kind: "pulumi", dir: "stack", offered: false, waits: ADOPTION_WAITS.pulumi });
    expect(s.spawned).toEqual([]);
  });

  it("names its floor in the registry, and refuses the report and the start below it", async () => {
    expect(CHANT_FLOORS).toContainEqual(floorFor("adoption report"));
    const s = served({ version: "0.124.52" });
    const { body } = await s.get("/api/adopt");
    expect(body.refusal).toMatchObject({ code: "chant-too-old" });
    expect((await s.get("/api/adopt/report?member=net")).status).toBe(409);
    expect((await s.post({ member: "net" })).status).toBe(409);
    expect(s.reads).toEqual([]);
    expect(s.spawned).toEqual([]);
  });
});

describe("the report (behold#999)", () => {
  it("reads promote's dry run for the member's own state file, and lists every resource with its fate", async () => {
    const s = served();
    const { status, body } = await s.get("/api/adopt/report?member=net");
    expect(status).toBe(200);
    expect(s.reads).toEqual([{ root: s.root, member: "net", state: join(s.root, "net", "terraform.tfstate") }]);
    expect(body.outcome).toBe("dry-run");
    expect(body.words).toMatch(/No gate was recorded and nothing was written/);
    expect(body.report.total).toBe(ENTRIES.length);
    expect(body.report.entries.map((e: { address: string; fate: string }) => [e.address, e.fate])).toEqual([
      ["aws_s3_bucket.logs", "claimed"],
      ["aws_vpc.main", "claimed"],
      ["aws_s3_bucket.gone", "left-out"],
      ["aws_s3_bucket_versioning.logs", "left-out"],
      ["aws_kms_alias.a", "left-out"],
    ]);
    expect(body.report.leftOut).toEqual({ MISSING: 1, UNTAGGABLE: 1, UNADMITTED_TYPE: 1 });
    for (const e of body.report.entries) expect(e.why).toBeTruthy();
    expect(body.approve).toBe("chant approve workspace-promote net --plan sha256:abc");
    expect(s.spawned).toEqual([]);
  });

  it("is the read-only stage: always --dry-run, never the gate or -approve", () => {
    const argv = promoteReportArgv("net", "/s/terraform.tfstate");
    expect(argv).toEqual(["workspace", "promote", "net", "--state", "/s/terraform.tfstate", "--dry-run", "--json"]);
    expect(PROMOTE_REPORT_READ).toBe("promote --dry-run");
  });

  it("takes a state file name in the member's directory and nothing else", async () => {
    const s = served();
    expect((await s.get("/api/adopt/report?member=net&state=../app/terraform.tfstate")).status).toBe(400);
    expect((await s.get("/api/adopt/report?member=net&state=%2Fetc%2Fpasswd")).status).toBe(400);
    expect((await s.get("/api/adopt/report?member=edge")).body).toMatchObject({ code: "adopt-state" });
    expect((await s.get("/api/adopt/report?member=stack")).body).toMatchObject({ code: "adopt-kind", error: ADOPTION_WAITS.pulumi });
    expect((await s.get("/api/adopt/report?member=app")).status).toBe(422);
    expect((await s.get("/api/adopt/report?member=nope")).status).toBe(400);
    expect(s.reads).toEqual([]);
    const m = { name: "x", dir: "x", kind: "terraform", abs: "/w/x", reason: null, because: null };
    expect(stateFileFor(m, "prod.tfstate")).toMatchObject({ ok: true, abs: "/w/x/prod.tfstate", present: false });
    expect(stateFileFor(m, "a/b.tfstate").ok).toBe(false);
  });

  it("an unknown status is listed, as unknown, never dropped", () => {
    const r = adoptionReportOf({ outcome: "dry-run", adoption: { entries: [{ address: "a.b", type: "a", status: "NEW_ONE", detail: "d" }] } })!;
    expect(r.entries).toEqual([{ address: "a.b", type: "a", status: "NEW_ONE", fate: "unknown", why: expect.stringMatching(/does not know/), detail: "d", liveId: null }]);
    expect(r.leftOut).toEqual({ NEW_ONE: 1 });
  });
});

describe("the reader's adoption read (behold#999)", () => {
  it("is one chant call of the dry run, the document handed back as chant printed it", async () => {
    const calls: string[][] = [];
    const printed = doc("dry-run");
    const reader = workspaceReader({ run: async (argv) => (calls.push(argv), { status: 0, stdout: JSON.stringify(printed), stderr: "" }) });
    expect(await reader.readPromoteReport("net", "/s")).toEqual(printed);
    expect(calls).toEqual([["workspace", "promote", "net", "--state", "/s", "--dry-run", "--json"]]);
  });
  it("refuses with chant's words when promote refused before printing anything", async () => {
    const reader = workspaceReader({ run: async () => ({ status: 1, stdout: "", stderr: "✗ net has uncommitted changes (net/main.tf). Commit them" }) });
    const err = await reader.readPromoteReport("net", "/s").catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceReadError);
    expect((err as WorkspaceReadError).refusal).toMatchObject({ code: "workspace-promote", error: expect.stringMatching(/uncommitted changes/) });
  });
});

describe("starting adoption: no write before approval (behold#999)", () => {
  it("starts the gated promote at the workspace root, with no --dry-run and no -approve, and reads exit 3 as the gate holding", async () => {
    const s = served({ exit: 3 });
    const r = await s.post({ member: "net" });
    expect(r.status).toBe(202);
    const { id, command } = (await r.json()) as { id: string; command: string };
    const state = join(s.root, "net", "terraform.tfstate");
    expect(s.spawned).toEqual([{ args: ["workspace", "promote", "net", "--state", state, "--json"], cwd: s.root }]);
    expect(promoteStartArgv("net", state)).toEqual(s.spawned[0].args);
    expect(s.spawned[0].args.some((a) => a === "-approve" || a === "--approve" || a === "--force" || a === "--yes")).toBe(false);
    expect(command).toBe(`chant workspace promote net --state ${state} --json`);
    await vi.waitFor(() => expect(s.runner.running).toBeNull());
    expect(s.said).toContain("■ chant workspace promote net exited 0");
    const run = (await s.get(`/api/adopt/runs/${id}`)).body;
    expect(run).toMatchObject({ outcome: "gated", exitCode: 3, digest: "sha256:abc", approve: promoteApproveLine("net", "sha256:abc") });
    expect(run.words).toMatch(/^Gated: nothing was written\./);
    expect(run.report.total).toBe(ENTRIES.length);
  });

  it("after an approval the same command applies; behold reports what chant did and decides nothing", async () => {
    const s = served({ exit: 0 });
    const { id } = (await (await s.post({ member: "net" })).json()) as { id: string };
    await vi.waitFor(() => expect(s.runner.running).toBeNull());
    const run = (await s.get(`/api/adopt/runs/${id}`)).body;
    expect(run.outcome).toBe("applied");
    expect(run.approve).toBeUndefined();
  });

  it("refuses in preview mode, without a state file, for a kind it does not adopt, and a second start while one runs", async () => {
    expect((await served({ preview: true }).post({ member: "net" })).status).toBe(403);
    const s = served({ hold: true });
    expect((await (await s.post({ member: "edge" })).json()) as object).toMatchObject({ code: "adopt-state" });
    expect((await s.post({ member: "stack" })).status).toBe(422);
    expect((await s.post({ member: "net", state: "../x.tfstate" })).status).toBe(400);
    expect((await s.post({ member: "net" })).status).toBe(202);
    expect((await (await s.post({ member: "net" })).json()) as object).toMatchObject({ code: "busy" });
    s.release(3);
    await vi.waitFor(() => expect(s.runner.running).toBeNull());
    expect(s.spawned).toHaveLength(1);
  });

  it("is refused whole in a public view", () => {
    expect(publicReadRefusal("/api/adopt", new URLSearchParams())).toMatch(/promote/);
    expect(publicReadRefusal("/api/adopt/report", new URLSearchParams())).toBeDefined();
    expect(publicReadRefusal("/api/adopt/runs/adopt-1-x", new URLSearchParams())).toBeDefined();
  });
});

// The terraform-estate demo: every resource each root declares, from its .tf
// files and the module it calls, is in that root's recorded report with a fate.
const ESTATE = join(import.meta.dirname, "..", "example-terraform-estate");
const RECORDED = join(ESTATE, "recorded", "adoption");
const resourcesIn = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".tf"))
    .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/^resource "([^"]+)" "([^"]+)"/gm)].map((m) => `${m[1]}.${m[2]}`));
const moduleCallsIn = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".tf"))
    .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/^module "([^"]+)"/gm)].map((m) => m[1]));

describe("the terraform-estate demo offers adoption (behold#999)", () => {
  const roots = { prod: join(ESTATE, "envs", "prod"), platform: join(ESTATE, "platform") };
  const declared = (dir: string) => [...resourcesIn(dir), ...moduleCallsIn(dir).flatMap((m) => resourcesIn(join(ESTATE, "modules", "service")).map((r) => `module.${m}.${r}`))].sort();

  for (const [member, dir] of Object.entries(roots)) {
    it(`${member}: the recorded report lists every resource the root declares, each claimed or left out with a reason`, () => {
      const recorded = JSON.parse(readFileSync(join(RECORDED, `${member}.json`), "utf8")) as WorkspaceDocument;
      const report = adoptionReportOf(recorded)!;
      expect(report.entries.map((e) => e.address).sort()).toEqual(declared(dir));
      for (const e of report.entries) {
        expect(["claimed", "left-out"]).toContain(e.fate);
        expect(e.detail).toBeTruthy();
      }
      expect(report.claimed).toBe(report.entries.filter((e) => e.fate === "claimed").length);
    });
  }

  it("serves the recorded report, labelled, and starts nothing", async () => {
    const s = served({ recorded: RECORDED, version: "0.1.0" });
    // The demo's members are prod and platform; this workspace's are net and edge, so ask through a demo-shaped one.
    const ws: Workspace = { name: "example-terraform-estate", root: ESTATE, file: "chant.workspace.json", chant: "0.124.52", members: Object.entries(roots).map(([name, abs]) => ({ name, dir: abs.slice(ESTATE.length + 1), kind: "terraform", abs, reason: null, because: null })) };
    const app = new Hono();
    const spawned: string[][] = [];
    adoptionRoutes(app, { workspace: () => ws, runner: s.runner, broadcaster: new Broadcaster(), readReport: async () => { throw new Error("no live read in the demo"); }, recorded: () => RECORDED, chantVersion: () => "0.1.0", spawn: (args) => (spawned.push(args), { done: Promise.resolve(0) }) });
    const offer = (await (await app.request("/api/adopt")).json()) as { recorded: string; refusal: null; offers: { member: string; recorded: boolean; start: { offered: boolean } }[] };
    expect(offer.refusal).toBeNull();
    expect(offer.recorded).toBe(RECORDED_NOTE);
    expect(offer.offers.map((o) => [o.member, o.recorded, o.start.offered])).toEqual([["prod", true, false], ["platform", true, false]]);
    const report = (await (await app.request("/api/adopt/report?member=prod")).json()) as { recorded: string; report: { total: number } };
    expect(report.recorded).toBe(RECORDED_NOTE);
    expect(report.report.total).toBe(25);
    const start = await app.request("/api/adopt/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ member: "prod" }) });
    expect(start.status).toBe(409);
    expect(spawned).toEqual([]);
  });
});
