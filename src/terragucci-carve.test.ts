// #715: the live carve's read of terragucci's estate rosters (terragucci#1130)
// and migration progress (terragucci#1129), and its gate: with no choudoufu
// roots and no rosters the route answers `live: false`, and the page mounts
// nothing, so the kiosk and the app are as they were.
import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";

vi.mock("./estate.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./estate.ts")>()),
  composeEstate: vi.fn(),
}));
import { composeEstate } from "./estate.ts";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { terragucciSource } from "./terragucci-source.ts";
import { countLines, currentCycle, demoMigration, estateEntries, progressLine, readCarve, readProgress, recordCounts } from "./terragucci-carve.ts";

const HERE = import.meta.dirname;
const BUCKET = join(HERE, "..", "example-terragucci-reports");
const IR = (): GraphIR => ({ ...(JSON.parse(readFileSync(join(HERE, "__fixtures__", "terragucci-example-ir.json"), "utf8")) as GraphIR), edges: [], groups: {} });

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
};
const put = (dir: string, key: string, body: string): void => {
  const at = join(dir, ...key.split("/"));
  mkdirSync(at.slice(0, at.lastIndexOf("/")), { recursive: true });
  writeFileSync(at, body);
};

const PROJECT = "github.com/demo/terralith";
// choudoufu's -progress-json line, with the migration and its counts as terragucci appends it (terragucci#1133).
const line = (o: Record<string, unknown>, counts: Record<string, number>) => JSON.stringify({ at: "2026-10-16T10:00:00Z", estate_from: "terralith", estate_to: "terralith", live_id: "", ...o, migration: "carve", counts });

/** A reports bucket mid-carve: a stock roster, an adoption that ran, and a split halfway. */
function bucket(opts: { estates?: boolean; split?: boolean } = { estates: true, split: true }): string {
  const dir = tmp("behold-carve-");
  put(
    dir,
    "index.json",
    JSON.stringify({
      schema: "terragucci.report-index/v1",
      reports: [{ project: PROJECT, commit: "abc", stage: "tf-apply", wave: 1, finished: "2026-10-16T10:00:00Z", path: `${PROJECT}/abc/tf-apply/wave-1` }],
    }),
  );
  if (opts.estates) {
    // terragucci#1132: the estates index at the top of the prefix, each roster's key relative to it.
    put(dir, "estates.json", JSON.stringify({ schema: "terragucci.estates/v1", estates: [
      { estate: "terralith", count: 3, at: "2026-10-16T09:59:00Z", project: PROJECT, root: "terralith", roster: "estates/terralith/roster.json" },
      { estate: "team-a", count: 1, at: "2026-10-16T10:00:01Z", project: "github.com/demo/team-a", root: "team-a", roster: "estates/team-a/roster.json" },
    ] }));
    put(dir, "estates/terralith/roster.json", JSON.stringify({ estate: "terralith", at: "2026-10-16T09:59:00Z", resources: [
      { address: "module.team_a.aws_iam_role.app", type: "aws_iam_role", live_id: "role-a", marked: true },
      { address: "module.team_a.aws_iam_role_policy.app", type: "aws_iam_role_policy", marked: false, follows: "module.team_a.aws_iam_role.app" },
      { address: "module.team_b.aws_iam_role.app", type: "aws_iam_role", live_id: "role-b", marked: true },
    ] }));
    put(dir, "estates/team-a/roster.json", JSON.stringify({ estate: "team-a", at: "2026-10-16T10:00:01Z", resources: [{ address: "aws_iam_role.app", type: "aws_iam_role", live_id: "role-a", marked: true }] }));
  }
  put(dir, "demo.json", JSON.stringify({ cycle: 3, scenario: "terralith", title: "Carving the terralith", step: "applying", label: "wave 1", started_at: "2026-10-16T09:58:00Z", next: { action: "carve: 1 of 2 moved", at: null }, pull: null, commit: "abc" }));
  if (opts.split) {
    put(dir, `${PROJECT}/migrations/carve.json`, JSON.stringify({ name: "carve", status: "waiting", progress: { moved: 1, stamped: 0, refused: 1, skipped: 0, left: 1 } }));
    put(
      dir,
      `${PROJECT}/migrations/carve/progress.jsonl`,
      [
        line({ address: "module.team_a.aws_iam_role.app", live_id: "role-a", estate_to: "team-a", outcome: "moved" }, { moved: 1, stamped: 0, refused: 0, skipped: 0, left: 2 }),
        line({ at: "2026-10-16T10:00:02Z", address: "module.team_b.aws_iam_role.app", live_id: "role-b", estate_to: "team-b", outcome: "refused", reason: "Unexpected changes in the marker rewrite" }, { moved: 1, stamped: 0, refused: 1, skipped: 0, left: 1 }),
        '{"at":"2026-10-16T10:00:03Z","estate_from":"terra', // half written: the job is appending
      ].join("\n"),
    );
  }
  return dir;
}

describe("the live carve's read (#715)", () => {
  it("reads the rosters, the migration demo.json names, its counts and its lines", async () => {
    const a = await readCarve(terragucciSource(bucket()), { choudoufu: () => false });
    expect(a.live).toBe(true);
    if (!a.live) return;
    expect(a.gate).toEqual({ choudoufu: false, rosters: 2 });
    expect(a.estates.map((e) => [e.estate, e.count, e.resources.length])).toEqual([["terralith", 3, 3], ["team-a", 1, 1]]);
    expect(a.estates[0]!.resources[1]).toEqual({ address: "module.team_a.aws_iam_role_policy.app", type: "aws_iam_role_policy", marked: false, follows: "module.team_a.aws_iam_role.app" });
    expect(a.demo?.next).toBe("carve: 1 of 2 moved");
    expect(a.migrations).toHaveLength(1);
    const m = a.migrations[0]!;
    expect(m.name).toBe("carve");
    expect(m.progress).toBe(`${PROJECT}/migrations/carve/progress.jsonl`);
    expect(m.lines.map((l) => l.outcome)).toEqual(["moved", "refused"]);
    expect(m.lines[1]!.reason).toMatch(/marker rewrite/);
    expect(m.counts).toEqual({ moved: 1, stamped: 0, refused: 1, skipped: 0, left: 1 });
    expect(m.running).toBe(true);
    expect(a.running).toBe(true);
    // The half-written last line is the job appending, not a problem.
    expect(a.problems).toEqual([]);
  });

  it("takes the counts from the lines while the record has none yet", async () => {
    const dir = bucket();
    put(dir, `${PROJECT}/migrations/carve.json`, JSON.stringify({ name: "carve", status: "waiting" }));
    const a = await readCarve(terragucciSource(dir), { choudoufu: () => false });
    if (!a.live) throw new Error("shut");
    expect(a.migrations[0]!.counts).toEqual({ moved: 1, stamped: 0, refused: 1, skipped: 0, left: 1 });
  });

  it("finds the project in the reports index when no estate names one", async () => {
    const dir = bucket({ estates: false, split: true });
    const a = await readCarve(terragucciSource(dir), { choudoufu: () => true });
    if (!a.live) throw new Error("shut");
    expect(a.migrations.map((m) => m.progress)).toEqual([`${PROJECT}/migrations/carve/progress.jsonl`]);
  });

  it("reads an adoption's stamp, whose line has no estate_from", async () => {
    const dir = bucket({ estates: true, split: false });
    put(dir, "demo.json", JSON.stringify({ cycle: 3, scenario: "terralith", title: "Adopting", step: "applying", label: "wave 1", started_at: "2026-10-16T09:58:00Z", next: { action: "adopt: 1 of 3 stamped", at: null }, pull: null, commit: "abc" }));
    put(dir, `${PROJECT}/migrations/adopt/progress.jsonl`, JSON.stringify({ at: "2026-10-16T10:00:00Z", estate_from: "", estate_to: "terralith", address: "aws_vpc.main", live_id: "vpc-1", outcome: "stamped", migration: "adopt", counts: { moved: 0, stamped: 1, refused: 0, skipped: 0, left: 2 } }) + "\n");
    const a = await readCarve(terragucciSource(dir), { choudoufu: () => false });
    if (!a.live) throw new Error("shut");
    const m = a.migrations.find((x) => x.name === "adopt")!;
    expect(m.lines[0]).toMatchObject({ estate_from: "terralith", estate_to: "terralith", outcome: "stamped", live_id: "vpc-1" });
    expect(m.counts.stamped).toBe(1);
    expect(m.running).toBe(true);
  });

  it("does not read keys terragucci does not write", async () => {
    const dir = bucket({ estates: false, split: false });
    // An index carrying an estates list is not where the estates are.
    put(dir, "index.json", JSON.stringify({ schema: "terragucci.report-index/v1", reports: [], estates: [{ estate: "terralith", roster: "estates/terralith/roster.json" }] }));
    put(dir, "estates/terralith/roster.json", JSON.stringify({ estate: "terralith", at: "x", resources: [{ address: "aws_vpc.main", type: "aws_vpc", marked: false }] }));
    const a = await readCarve(terragucciSource(dir), { choudoufu: () => false });
    expect(a.live).toBe(false);
  });

  it("is open on choudoufu roots alone, before any roster is written", async () => {
    const a = await readCarve(terragucciSource(bucket({ estates: false, split: false })), { choudoufu: () => true });
    expect(a.live).toBe(true);
    if (a.live) expect(a.gate).toEqual({ choudoufu: true, rosters: 0 });
  });

  it("is shut with no choudoufu roots and no rosters", async () => {
    const a = await readCarve(terragucciSource(bucket({ estates: false, split: false })), { choudoufu: () => false });
    expect(a.live).toBe(false);
  });

  it("keeps a migration demo.json named once, after its step moves on", async () => {
    const dir = bucket();
    const remembered = new Set<string>();
    await readCarve(terragucciSource(dir), { choudoufu: () => false, remembered });
    expect([...remembered]).toEqual(["carve"]);
    put(dir, "demo.json", JSON.stringify({ cycle: 3, scenario: "terralith", title: "t", step: "applied", label: "done", started_at: "2026-10-16T09:58:00Z", next: null, pull: null, commit: "abc" }));
    put(dir, `${PROJECT}/migrations/carve.json`, JSON.stringify({ name: "carve", status: "applied", finished: "2026-10-16T10:01:00Z", progress: { moved: 1, stamped: 0, refused: 1, skipped: 0, left: 0 } }));
    const a = await readCarve(terragucciSource(dir), { choudoufu: () => false, remembered });
    if (!a.live) throw new Error("shut");
    expect(a.migrations[0]!.running).toBe(false);
    expect(a.running).toBe(false);
  });

  it("parses the pieces it is coded against", () => {
    expect(demoMigration("carve: 36 of 79 moved")).toBe("carve");
    expect(demoMigration("adopt: 3 of 4 stamped")).toBe("adopt");
    expect(demoMigration("carve: 36 of 79 moved, 2 refused")).toBe("carve");
    expect(demoMigration("approve wave 2")).toBe(null);
    expect(progressLine({ at: "x", estate_from: "a", address: "b", outcome: "teleported" })).toBeUndefined();
    expect(progressLine({ at: "x", estate_from: "a", address: "b", outcome: "stamped" })?.estate_to).toBe("a");
    expect(progressLine({ at: "x", estate_from: "", estate_to: "", address: "b", outcome: "stamped" })).toBeUndefined();
    const p = readProgress('not json\n{"at":"x","estate_from":"a","address":"b","outcome":"moved"}\n{"at":');
    expect(p.lines).toHaveLength(1);
    expect(p.bad).toBe(1);
    expect(countLines(p.lines)).toEqual({ moved: 1, stamped: 0, refused: 0, skipped: 0, left: null });
    expect(recordCounts({ progress: { moved: 2, left: 3 } })).toEqual({ moved: 2, stamped: 0, refused: 0, skipped: 0, left: 3 });
    expect(recordCounts({ status: "waiting" })).toBe(null);
    expect(estateEntries({ estates: [{ estate: "x" }, { estate: "bad", roster: "../../etc/passwd" }, { estate: "ok", count: 2, project: "p", root: "r", roster: "estates/ok/roster.json" }] })).toEqual([
      { estate: "ok", count: 2, at: null, project: "p", root: "r", roster: "estates/ok/roster.json" },
    ]);
  });
});

describe("the gate (#715): with neither choudoufu roots nor rosters, nothing changes", () => {
  const checkout = (binary: string): string => {
    const dir = join(tmp("behold-carve-route-"), "repo");
    mkdirSync(join(dir, "envs", "dev", "platform"), { recursive: true });
    writeFileSync(join(dir, "envs", "dev", "platform", "main.tf"), 'resource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n');
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "terragucci.yml"), `binary: ${binary}\n`);
    return dir;
  };
  const served = (dir: string, source: string) => {
    const broadcaster = new Broadcaster();
    return createApp({ projectDir: dir, projectDirs: [dir], port: 0, terragucci: { source } }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
  };
  beforeEach(() => {
    vi.mocked(composeEstate).mockReset();
    vi.mocked(composeEstate).mockImplementation((async () => IR()) as never);
  });

  it("answers live: false over a tofu repo and a bucket with no rosters", async () => {
    const res = await served(checkout("tofu"), BUCKET).request("/api/terragucci/carve");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { live: boolean; reason?: string };
    expect(body.live).toBe(false);
    expect(body.reason).toMatch(/no choudoufu roots/);
  });

  it("opens on a choudoufu binary, and on rosters", async () => {
    const a = (await (await served(checkout("choudoufu"), BUCKET).request("/api/terragucci/carve")).json()) as { live: boolean };
    expect(a.live).toBe(true);
    const b = (await (await served(checkout("tofu"), bucket()).request("/api/terragucci/carve")).json()) as { live: boolean; estates: unknown[] };
    expect(b.live).toBe(true);
    expect(b.estates).toHaveLength(2);
  });

  it("leaves /api/project and /api/terragucci as they were", async () => {
    const app = served(checkout("tofu"), BUCKET);
    const project = (await (await app.request("/api/project")).json()) as Record<string, unknown>;
    expect(Object.keys(project).some((k) => /carve|dots/i.test(k))).toBe(false);
    const reports = (await (await app.request("/api/terragucci")).json()) as Record<string, unknown>;
    expect(Object.keys(reports).some((k) => /carve|dots|estates|roster/i.test(k))).toBe(false);
  });
});

// The demo's reports prefix holds every demo repo's roots, so the carve draws
// only the carved project's: the repo demo.json names, and the projects its
// migrations move resources into.
describe("the carve draws the carved project's estates, not the whole prefix", () => {
  const F = "forgejo:3000/admin";
  const TL = `${F}/demo-terralith`;
  const roster = (estate: string, address: string, marked: boolean) => JSON.stringify({ estate, at: "2026-10-16T10:00:00Z", resources: [{ address, type: address.split(".")[0], marked }] });
  const entry = (estate: string, project: string, root: string) => ({ estate, count: 1, at: "2026-10-16T10:00:00Z", project, root, roster: `estates/${estate}/roster.json` });
  const demoJson = (o: Record<string, unknown>) =>
    JSON.stringify({ cycle: 7, scenario: "terralith", title: "t", step: "applying", label: "l", started_at: "2026-10-16T09:58:00Z", next: null, pull: null, commit: null, ...o });

  /** Every demo repo's roots in one prefix: Terraform's, Terragrunt's, chant's and the terralith's, and after a split the team repos'. */
  function mixed(opts: { teams?: boolean; stock?: boolean; old?: boolean } = {}): string {
    const dir = tmp("behold-carve-mixed-");
    const estates = [
      entry("app", `${F}/demo`, "app"),
      entry("network", `${F}/demo`, "network"),
      entry("edge", `${F}/demo`, "edge"),
      entry("other", `${F}/demo`, "other"),
      entry("units/vpc", `${F}/demo-terragrunt`, "units/vpc"),
      entry("components/api", `${F}/demo-chant`, "components/api"),
      // The stock beat: the terralith's one stock root, before the adoption names an estate.
      opts.stock ? entry("root", TL, ".") : entry("tl7-terralith", TL, "."),
      ...(opts.teams ? ["a", "b", "c"].map((t) => entry(`tl7-team-${t}`, `${TL}-team-${t}`, ".")) : []),
      // The cycle before: its estates stay in estates.json, written before this cycle started.
      ...(opts.old ? [{ ...entry("tl6-terralith", TL, "."), at: "2026-10-16T09:00:00Z" }, ...["a", "b", "c"].map((t) => ({ ...entry(`tl6-team-${t}`, `${TL}-team-${t}`, "."), at: "2026-10-16T09:10:00Z" }))] : []),
    ];
    put(dir, "estates.json", JSON.stringify({ schema: "terragucci.estates/v1", estates }));
    for (const e of estates) put(dir, e.roster, roster(e.estate, /^tl\d+-|^root$/.test(e.estate) ? "aws_iam_role.r" : "terraform_data.d", /^tl\d+-/.test(e.estate)));
    return dir;
  }

  it("draws only the terralith's projects from a mixed prefix", async () => {
    const dir = mixed();
    put(dir, "demo.json", demoJson({ tool: "terralith", repo: "admin/demo-terralith" }));
    const a = await readCarve(terragucciSource(dir), { choudoufu: () => true });
    if (!a.live) throw new Error(`shut: ${a.reason}`);
    expect(a.estates.map((e) => e.estate)).toEqual(["tl7-terralith"]);
    expect(a.projects).toEqual([TL]);
    expect(a.gate).toEqual({ choudoufu: true, rosters: 1 });
  });

  it("is shut while demo.json names the Terraform repo, whatever the served checkout holds", async () => {
    const dir = mixed();
    put(dir, "demo.json", demoJson({ scenario: "b-waves", tool: "terraform", repo: "admin/demo", next: { action: "approve wave-2", at: null } }));
    const a = await readCarve(terragucciSource(dir), { choudoufu: () => true });
    expect(a.live).toBe(false);
    if (!a.live) expect(a.reason).toMatch(/admin\/demo/);
  });

  it("adds the team projects a split moves resources into, and keeps them in the team beat", async () => {
    const dir = mixed({ teams: true });
    put(dir, "demo.json", demoJson({ tool: "terralith", repo: "admin/demo-terralith", next: { action: "split: 2 of 3 moved", at: null } }));
    // The record names team C's estate; the lines so far name A's and B's.
    put(dir, `${TL}/migrations/split.json`, JSON.stringify({ name: "split", status: "waiting", moves: [{ from_estate: "tl7-terralith", to_estate: "tl7-team-c" }] }));
    put(
      dir,
      `${TL}/migrations/split/progress.jsonl`,
      ["a", "b"].map((t) => JSON.stringify({ at: "2026-10-16T10:00:00Z", estate_from: "tl7-terralith", estate_to: `tl7-team-${t}`, address: `aws_iam_role.${t}`, live_id: `role-${t}`, outcome: "moved", migration: "split" })).join("\n") + "\n",
    );
    const remembered = new Set<string>();
    const places = new Map<string, string | null>();
    const a = await readCarve(terragucciSource(dir), { choudoufu: () => false, remembered, places });
    if (!a.live) throw new Error(`shut: ${a.reason}`);
    const drawn = ["tl7-team-a", "tl7-team-b", "tl7-team-c", "tl7-terralith"];
    expect(a.estates.map((e) => e.estate).sort()).toEqual(drawn);
    expect(a.projects).toEqual([TL, `${TL}-team-a`, `${TL}-team-b`, `${TL}-team-c`]);
    expect(a.migrations.map((m) => m.name)).toEqual(["split"]);

    // The team beat: demo.json names team B's repo, and the split, seen before, still names the rest.
    put(dir, "demo.json", demoJson({ tool: "terralith", repo: "admin/demo-terralith-team-b", step: "planned" }));
    const b = await readCarve(terragucciSource(dir), { choudoufu: () => false, remembered, places });
    if (!b.live) throw new Error(`shut: ${b.reason}`);
    expect(b.estates.map((e) => e.estate).sort()).toEqual(drawn);
  });

  it("draws only this cycle's estates, not the cycle before's", async () => {
    const dir = mixed({ teams: true, old: true });
    put(dir, "demo.json", demoJson({ tool: "terralith", repo: "admin/demo-terralith", next: { action: "split: 2 of 3 moved", at: null } }));
    put(dir, `${TL}/migrations/split.json`, JSON.stringify({ name: "split", status: "waiting", moves: ["a", "b", "c"].map((t) => ({ from_estate: "tl7-terralith", to_estate: `tl7-team-${t}` })) }));
    const a = await readCarve(terragucciSource(dir), { choudoufu: () => false });
    if (!a.live) throw new Error(`shut: ${a.reason}`);
    expect(a.estates.map((e) => e.estate).sort()).toEqual(["tl7-team-a", "tl7-team-b", "tl7-team-c", "tl7-terralith"]);
    // With no started_at, the newest estate of each root.
    const entries = estateEntries(JSON.parse(readFileSync(join(dir, "estates.json"), "utf8")));
    expect(currentCycle(entries, null).map((e) => e.estate).filter((e) => e.startsWith("tl")).sort()).toEqual(["tl7-team-a", "tl7-team-b", "tl7-team-c", "tl7-terralith"]);
  });

  it("opens on the terralith's stock root, before the adoption exists", async () => {
    const dir = mixed({ stock: true });
    put(dir, "demo.json", demoJson({ tool: "terralith", repo: "admin/demo-terralith", step: "applied" }));
    const a = await readCarve(terragucciSource(dir), { choudoufu: () => false });
    if (!a.live) throw new Error(`shut: ${a.reason}`);
    expect(a.estates.map((e) => [e.estate, e.resources.every((r) => !r.marked)])).toEqual([["root", true]]);
    expect(a.migrations).toEqual([]);
    // A driver that writes no tool: the repo's one stock roster at its top opens it too.
    put(dir, "demo.json", demoJson({ repo: "admin/demo-terralith", step: "applied" }));
    expect((await readCarve(terragucciSource(dir), { choudoufu: () => false })).live).toBe(true);
  });

  it("draws every estate for a plain serve: no repo named and no migration found", async () => {
    const dir = mixed();
    put(dir, "demo.json", demoJson({}));
    const a = await readCarve(terragucciSource(dir), { choudoufu: () => false });
    if (!a.live) throw new Error("shut");
    expect(a.estates).toHaveLength(7);
    expect(a.projects).toBe(null);
  });
});

// The live local run, cycle 5 (floci, s3://demo-reports/demo): the adoption
// stamped all 82 resources within a second, between two of demo.json's
// writes, so demo.json never named it; and estates.json holds both the stock
// roster and the estate it became, in the same project and root.
describe("cycle 5's adoption: found by listing, and one box with its stock root", () => {
  const P = "forgejo:3000/terragucci-admin/demo-terralith";
  const START = "2026-10-17T08:05:00Z";
  const N = 82;
  const addr = (i: number) => `aws_iam_role.r${String(i).padStart(2, "0")}`;
  const stamp = (i: number) => ({ at: "2026-10-17T08:11:21.77Z", estate_from: "", estate_to: "tl5-terralith", address: addr(i), live_id: i % 2 ? "" : `role-${i}`, outcome: i % 2 ? "skipped" : "stamped", migration: "adopt" });
  const mtime = (dir: string, k: string, iso: string) => utimesSync(join(dir, ...k.split("/")), new Date(iso), new Date(iso));

  function cycle5(opts: { estate?: boolean; lines?: number; finished?: boolean } = {}): string {
    const dir = tmp("behold-carve-c5-");
    const lines = opts.lines ?? N;
    const stock = { estate: "terralith", count: N, at: "2026-10-17T08:09:15Z", project: P, root: "terralith", roster: "estates/terralith/roster.json" };
    const adopted = { estate: "tl5-terralith", count: N, at: "2026-10-17T08:11:32Z", project: P, root: "terralith", roster: "estates/tl5-terralith/roster.json" };
    put(dir, "estates.json", JSON.stringify({ schema: "terragucci.estates/v1", estates: opts.estate === false ? [stock] : [stock, adopted] }));
    put(dir, stock.roster, JSON.stringify({ estate: "terralith", at: stock.at, resources: Array.from({ length: N }, (_, i) => ({ address: addr(i), type: "aws_iam_role", marked: false })) }));
    put(dir, adopted.roster, JSON.stringify({ estate: "tl5-terralith", at: adopted.at, resources: Array.from({ length: N }, (_, i) => ({ address: addr(i), type: "aws_iam_role", ...(i % 2 ? {} : { live_id: `role-${i}` }), marked: i % 2 === 0 })) }));
    // demo.json went from "wait for the plan note" to applied: it never named the adoption.
    put(dir, "demo.json", JSON.stringify({ cycle: 5, scenario: "terralith", title: "t", step: "applied", label: "l", started_at: START, next: null, pull: 3, commit: "abc", tool: "terralith", repo: "terragucci-admin/demo-terralith" }));
    const done = opts.finished !== false;
    put(dir, `${P}/migrations/adopt.json`, JSON.stringify({ name: "adopt", change: "adopt", status: done ? "applied" : "waiting", ...(done ? { finished: "2026-10-17T08:11:22Z" } : {}), progress: { moved: 0, stamped: Math.ceil(lines / 2), refused: 0, skipped: Math.floor(lines / 2), left: N - lines } }));
    put(dir, `${P}/migrations/adopt/progress.jsonl`, Array.from({ length: lines }, (_, i) => JSON.stringify(stamp(i))).join("\n") + "\n");
    mtime(dir, `${P}/migrations/adopt.json`, "2026-10-17T08:11:23Z");
    // The cycle before's migration: its record and its lines are older than this cycle's start.
    put(dir, `${P}/migrations/split.json`, JSON.stringify({ name: "split", status: "applied", finished: "2026-10-17T07:40:00Z" }));
    put(dir, `${P}/migrations/split/progress.jsonl`, JSON.stringify({ at: "2026-10-17T07:39:00Z", estate_from: "tl4-terralith", estate_to: "tl4-team-a", address: addr(0), live_id: "x", outcome: "moved" }) + "\n");
    mtime(dir, `${P}/migrations/split.json`, "2026-10-17T07:40:01Z");
    return dir;
  }

  it("follows the adoption demo.json never named, found by listing the project's migrations, and not the cycle before's", async () => {
    const a = await readCarve(terragucciSource(cycle5()), { choudoufu: () => false });
    if (!a.live) throw new Error(`shut: ${a.reason}`);
    expect(a.migrations.map((m) => m.name)).toEqual(["adopt"]);
    const m = a.migrations[0]!;
    expect(m.lines).toHaveLength(N);
    expect(m.counts).toEqual({ moved: 0, stamped: 41, refused: 0, skipped: 41, left: 0 });
    expect(m.running).toBe(false);
    expect(m.progress).toBe(`${P}/migrations/adopt/progress.jsonl`);
  });

  it("draws the adopted estate in place of its stock root, as one box", async () => {
    const a = await readCarve(terragucciSource(cycle5()), { choudoufu: () => false });
    if (!a.live) throw new Error(`shut: ${a.reason}`);
    expect(a.estates.map((e) => e.estate)).toEqual(["tl5-terralith"]);
    expect(a.adopted).toEqual([{ from: "terralith", to: "tl5-terralith" }]);
  });

  it("mid-adoption, before the estate's roster exists, draws the stock root and pairs it with the estate its stamps go into", async () => {
    const a = await readCarve(terragucciSource(cycle5({ estate: false, lines: 30, finished: false })), { choudoufu: () => false });
    if (!a.live) throw new Error(`shut: ${a.reason}`);
    expect(a.estates.map((e) => e.estate)).toEqual(["terralith"]);
    expect(a.adopted).toEqual([{ from: "terralith", to: "tl5-terralith" }]);
    expect(a.migrations[0]!.running).toBe(true);
  });
});
