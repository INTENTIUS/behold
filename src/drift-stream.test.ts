// behold#998: the streamed drift run, over a transport that prints recorded lines.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeDriftLine } from "./drift-line.ts";
import { Hono } from "hono";
import { CHANT_FLOORS, DRIFT_STREAM_CHANT_FLOOR, floorFor } from "./chant-floors.ts";
import { driftStreamRoutes, resourceBlocks, runDriftStream, toneFor, type DriftFrame } from "./drift-stream.ts";
import { driftStreamArgv, type StreamTransport } from "./workspace-reader.ts";
import type { Workspace, WorkspaceMember } from "./workspace.ts";

const member = (kind: string): WorkspaceMember => ({ name: "team-a", dir: "team-a", kind, abs: "/x/team-a", reason: null, because: null });

/** Prints `lines[argv's --resource]` (or `lines["*"]`) line by line, then exits `status`. */
function transport(lines: Record<string, string[]>, status = 0): StreamTransport & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    stream(argv, onLine) {
      asked.push(argv);
      const i = argv.indexOf("--resource");
      const out = lines[i === -1 ? "*" : argv[i + 1]] ?? [];
      let killed = false;
      const done = (async () => {
        for (const l of out) {
          if (killed) break;
          await Promise.resolve();
          onLine(l);
        }
        return { status: killed ? null : status, stderr: "" };
      })();
      return { done, kill: () => { killed = true; } };
    },
  };
}

const start = (resource: string, expected: string[]) => JSON.stringify({ type: "drift-start", drift: "v1", member: "tlmig-team-a", engine: "choudoufu", read: "plan", resource, expected });
const rec = (address: string, status: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "drift-record", member: "tlmig-team-a", engine: "choudoufu", address, node: null, observedAt: "2026-10-25T12:00:00Z", read: "plan", status, evidence: { tool: "choudoufu" }, ...extra });
const settle = (counts: Record<string, number>) => JSON.stringify({ type: "drift-settle", drift: "v1", member: "tlmig-team-a", engine: "choudoufu", read: "plan", counts });

describe("the streamed drift read", () => {
  it("runs workspace drift --member --resource --stream, the resource after its flag", () => {
    expect(driftStreamArgv({ member: "m", resource: "aws_vpc.main" })).toEqual(["workspace", "drift", "--member", "m", "--resource", "aws_vpc.main", "--stream"]);
    expect(driftStreamArgv({ member: "m" })).toEqual(["workspace", "drift", "--member", "m", "--stream"]);
  });

  it("decodes choudoufu H2's fixture as chant C1 does", () => {
    const text = readFileSync(new URL("./__fixtures__/drift-stream/choudoufu-resource.ndjson", import.meta.url), "utf8");
    const lines = text.trim().split("\n").map(decodeDriftLine);
    expect(lines.map((l) => l.type)).toEqual(["drift-start", "drift-record", "drift-record", "drift-record", "drift-settle"]);
  });

  it("refuses a not-observed record without a reason, and a state read that says in-sync", () => {
    expect(() => decodeDriftLine(rec("a.b", "not-observed"))).toThrow(/unobserved.reason/);
    expect(() => decodeDriftLine(rec("a.b", "in-sync", { read: "state" }))).toThrow(/state read/);
  });
});

describe("resourceBlocks", () => {
  it("drops instance keys and data sources, each block once", () => {
    expect(resourceBlocks(["aws_eip.pool[0]", "aws_eip.pool[1]", "data.aws_vpc.x", "module.a[\"k.v\"].data.aws_ami.y", "module.a.aws_s3_bucket.b", "-rf", "aws_vpc.main"]))
      .toEqual(["aws_eip.pool", "module.a.aws_s3_bucket.b", "aws_vpc.main"]);
  });
});

describe("toneFor", () => {
  it("paints an unknown status neutral and says so", () => {
    expect(toneFor({ status: "nonsense" as never, read: "plan" })).toEqual({ tone: "neutral", label: 'unknown status "nonsense"', unknown: true });
    expect(toneFor({ status: "in-sync", read: "plan" }).tone).toBe("good");
  });
});

describe("runDriftStream", () => {
  it("asks a choudoufu member one resource at a time and turns a silent one into not-reached at settle", async () => {
    const t = transport({
      "aws_iam_role.r": [start("aws_iam_role.r", ["aws_iam_role.r"]), rec("aws_iam_role.r", "drifted"), settle({ drifted: 1 })],
      "aws_vpc.main": [start("aws_vpc.main", ["aws_vpc.main"]), settle({})],
    });
    const frames: DriftFrame[] = [];
    await runDriftStream({ run: 1, member: member("choudoufu"), addresses: ["aws_iam_role.r", "aws_vpc.main"], transport: t, emit: (f) => frames.push(f), now: () => "2026-10-25T12:00:01Z" });
    expect(t.asked.map((a) => a[a.indexOf("--resource") + 1])).toEqual(["aws_iam_role.r", "aws_vpc.main"]);
    expect(frames.map((f) => f.kind)).toEqual(["begin", "start", "record", "settle", "start", "record", "settle", "end"]);
    // Keyed by the member behold asked about, not the estate name choudoufu writes.
    expect(frames.every((f) => f.member === "team-a")).toBe(true);
    const silent = frames[5];
    expect(silent).toMatchObject({ kind: "record", address: "aws_vpc.main", status: "not-observed", reason: "not-reached", notReached: true, tone: "neutral" });
    expect(frames[6]).toMatchObject({ kind: "settle", notReached: ["aws_vpc.main"] });
  });

  it("stops after a read that never started: the command itself failed", async () => {
    const t = transport({}, 1);
    const frames: DriftFrame[] = [];
    await runDriftStream({ run: 2, member: member("choudoufu"), addresses: ["aws_iam_role.r", "aws_vpc.main"], transport: t, emit: (f) => frames.push(f) });
    expect(t.asked).toHaveLength(1);
    expect(frames.map((f) => f.kind)).toEqual(["begin", "failed", "end"]);
  });

  it("kills a read that prints a line it cannot decode", async () => {
    const t = transport({ "*": [start("x", ["aws_vpc.main"]), "not json", rec("aws_vpc.main", "in-sync")] });
    const frames: DriftFrame[] = [];
    await runDriftStream({ run: 3, member: member("chant"), transport: t, emit: (f) => frames.push(f) });
    expect(frames.map((f) => f.kind)).toEqual(["begin", "start", "failed", "end"]);
    expect(frames[2]).toMatchObject({ kind: "failed", error: expect.stringMatching(/cannot read/) });
  });
});

// behold#1005: the streamed read has its own floor, DRIFT_STREAM_CHANT_FLOOR.
// Below it the start is refused with the floor's words before anything runs.
describe("the streamed drift start's chant floor (behold#1005)", () => {
  const ws: Workspace = { name: "w", root: "/x", file: "chant.workspace.json", chant: "", members: [member("chant")] };
  function served(version: string | undefined, chantBin?: string) {
    const t = transport({ "*": [] });
    const frames: DriftFrame[] = [];
    const app = new Hono();
    driftStreamRoutes(app, { workspace: () => ws, transport: () => t, emit: (f) => frames.push(f), chantVersion: () => version, ...(chantBin ? { chantBin } : {}) });
    const post = (body: unknown) => app.request("/api/workspace/drift/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { t, frames, post };
  }

  it("is registered, and doctor lists it", () => {
    expect(CHANT_FLOORS).toContainEqual(floorFor("streamed drift"));
    expect(floorFor("streamed drift").floor).toBe(DRIFT_STREAM_CHANT_FLOOR);
  });

  it("answers a chant below it with the floor refusal and spawns nothing", async () => {
    const s = served("0.124.52");
    const r = await s.post({ member: "team-a" });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "chant-too-old", chant: "0.124.52", error: expect.stringContaining(DRIFT_STREAM_CHANT_FLOOR) });
    expect(s.t.asked).toEqual([]);
    expect(s.frames).toEqual([]);
  });

  it("starts the read on a chant at the floor", async () => {
    const s = served(DRIFT_STREAM_CHANT_FLOOR);
    const r = await s.post({ member: "team-a" });
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 0));
    expect(s.t.asked).toEqual([driftStreamArgv({ member: "team-a" })]);
  });

  it("does not hold BEHOLD_DRIFT_CHANT's chant to the root's version", async () => {
    const s = served("0.124.52", "/fake/chant");
    expect((await s.post({ member: "team-a" })).status).toBe(202);
  });
});
