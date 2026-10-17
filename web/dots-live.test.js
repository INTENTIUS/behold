// #715: the dots layer's live driver. The route's answer (src/terragucci-carve.ts)
// becomes a show: one dot per resource, keyed by live id; a stamp leaves a
// ring, a move flies, a refusal bounces; lines play from when they were seen.
import { describe, it, expect } from "vitest";
import { liveShow, stampArrivals, lineKey, showKey, currentMigration, carveDrawable, boxName, LIVE } from "./dots-live.js";
import { buildScene, takeoffsBy } from "./dots-scene.js";
import { liveBeat, liveTipsBetween, liveEndTip } from "./dots-kiosk.js";
import { dotsCarving, dotsActive } from "./dots.js";

const T = Date.parse("2026-10-16T10:00:00Z");
const at = (s) => new Date(T + s * 1000).toISOString();

// A stock terralith (addresses only), adopted (stamped), then split: two moves and a refusal.
const stock = {
  estate: "terralith",
  at: at(-60),
  count: 4,
  resources: [
    { address: "module.team_a.aws_iam_role.app", type: "aws_iam_role", marked: false },
    { address: "module.team_a.aws_iam_role_policy.app", type: "aws_iam_role_policy", marked: false, follows: "module.team_a.aws_iam_role.app" },
    { address: "module.team_b.aws_iam_role.app", type: "aws_iam_role", marked: false },
    { address: "aws_vpc.main", type: "aws_vpc", marked: false },
  ],
};
const adopt = {
  name: "adopt",
  running: false,
  counts: { moved: 0, stamped: 3, refused: 0, skipped: 1, left: 0 },
  lines: [
    { at: at(0), estate_from: "terralith", estate_to: "terralith", address: "module.team_a.aws_iam_role.app", live_id: "role-a", outcome: "stamped" },
    { at: at(1), estate_from: "terralith", estate_to: "terralith", address: "module.team_b.aws_iam_role.app", live_id: "role-b", outcome: "stamped" },
    { at: at(2), estate_from: "terralith", estate_to: "terralith", address: "aws_vpc.main", live_id: "vpc-1", outcome: "stamped" },
    { at: at(3), estate_from: "terralith", estate_to: "terralith", address: "module.team_a.aws_iam_role_policy.app", outcome: "skipped" },
  ],
};
const split = (lines) => ({ name: "carve", running: true, counts: { moved: 1, stamped: 0, refused: lines.length > 2 ? 1 : 0, skipped: 0, left: 1 }, lines });
const moveA = { at: at(10), estate_from: "terralith", estate_to: "team-a", address: "module.team_a.aws_iam_role.app", live_id: "role-a", outcome: "moved" };
const followA = { at: at(10), estate_from: "terralith", estate_to: "team-a", address: "module.team_a.aws_iam_role_policy.app", outcome: "moved", follows: "module.team_a.aws_iam_role.app" };
const refuseB = { at: at(11), estate_from: "terralith", estate_to: "team-b", address: "module.team_b.aws_iam_role.app", live_id: "role-b", outcome: "refused", reason: "Unexpected changes in the marker rewrite" };
const answer = (migrations, estates = [stock]) => ({ live: true, source: "/tmp/reports", estates, migrations, demo: { title: "Carving the terralith", next: "carve: 1 of 2 moved" }, running: migrations.some((m) => m.running) });

describe("the live carve as a show (#715)", () => {
  it("keys a dot by live id once a stamp names it, and plays stock, adopt, split in order", () => {
    const a = answer([adopt, split([moveA, followA, refuseB])]);
    const seen = stampArrivals(a, new Map(), T + 20_000, { first: true });
    const show = liveShow(a, seen, T + 20_000);
    expect(show.kind).toBe("live");
    expect(show.source).toBe("terralith");
    expect(show.roster).toHaveLength(4);
    expect([...show.owners0.values()].every((e) => e === "terralith")).toBe(true);
    expect(show.ownersEnd.get("module.team_a.aws_iam_role.app")).toBe("team-a");
    // The policy follows its role.
    expect(show.ownersEnd.get("module.team_a.aws_iam_role_policy.app")).toBe("team-a");
    // The refused move leaves it where it was.
    expect(show.ownersEnd.get("module.team_b.aws_iam_role.app")).toBe("terralith");
    expect(show.events.filter((e) => e.kind === "adopt")).toHaveLength(3);
    const writes = show.events.filter((e) => e.kind === "write");
    expect(writes.map((w) => w.ok)).toEqual([true, false]);
    expect(writes[0].followers).toEqual(["module.team_a.aws_iam_role_policy.app"]);
    expect(writes[1].refusalSummary).toMatch(/marker rewrite/);
  });

  it("joins a destination roster's resource to its dot by live id, not as a second dot", () => {
    const teamA = { estate: "team-a", at: at(12), count: 1, resources: [{ address: "aws_iam_role.app", type: "aws_iam_role", live_id: "role-a", marked: true }] };
    const a = answer([adopt, split([moveA])], [stock, teamA]);
    const show = liveShow(a, stampArrivals(a, new Map(), T + 20_000, { first: true }), T + 20_000);
    expect(show.roster).toHaveLength(4);
    expect(show.estates).toContain("team-a");
  });

  it("draws the first read's lines where they ended, and flies a later line from when it was seen", () => {
    const first = answer([adopt]);
    const seen0 = stampArrivals(first, new Map(), T + 5_000, { first: true });
    expect(seen0.get(lineKey("adopt", adopt.lines[0]))).toBe(T);
    const later = answer([adopt, split([moveA, refuseB])]);
    const now = T + 30_000;
    const seen1 = stampArrivals(later, seen0, now);
    expect(seen1.get(lineKey("carve", moveA))).toBe(now);
    expect(seen1.get(lineKey("carve", refuseB))).toBeGreaterThan(now);
    expect(seen1.get(lineKey("carve", refuseB))).toBe(now + LIVE.stepMs);
    const show0 = liveShow(first, seen0, T + 5_000);
    const show1 = liveShow(later, seen1, now, { t0: show0.t0 });
    expect(show1.t0).toBe(show0.t0);
    expect(showKey(show1)).not.toBe(showKey(show0));
    const scene = buildScene(show1);
    const flight = scene.flights.find((f) => f.address === "module.team_a.aws_iam_role.app");
    // One to one: the flight starts at its arrival, in the show's own clock.
    expect(flight.start).toBe(now - show1.t0);
    expect(takeoffsBy(scene, now - show1.t0 - 1)).toBe(0);
    // The role and its policy, which follows it, take off together.
    expect(takeoffsBy(scene, now - show1.t0 + 1)).toBe(2);
    expect(scene.flights.find((f) => f.address === "module.team_a.aws_iam_role_policy.app").parent).toBe("module.team_a.aws_iam_role.app");
  });

  it("says what is happening from demo.json and the newest line, and tips the first landing and refusal", () => {
    const a = answer([adopt, split([moveA, followA, refuseB])]);
    const seen = stampArrivals(a, new Map(), T, { first: true });
    const show = liveShow(a, seen, T + 20_000);
    const scene = buildScene(show);
    const m = currentMigration(a);
    expect(m.name).toBe("carve");
    const mid = liveBeat(scene, T + 11_500 - show.t0, { demo: a.demo, migration: m });
    expect(mid.title).toBe("Carving the terralith");
    expect(mid.next.text).toBe("carve: 1 of 2 moved");
    expect(mid.line.tone).toBe("bad");
    const tips = liveTipsBetween(scene, -1, T + 20_000 - show.t0);
    expect(tips.map((t) => t.key).sort()).toEqual(["land:team-a", "refused"]);
    const done = liveBeat(scene, T + 20_000 - show.t0, { demo: null, migration: { ...m, running: false } });
    expect(done.phase).toBe("settled");
    expect(done.focus).toEqual({ kind: "all" });
    expect(liveEndTip(m, 0).key).toBe("end:carve");
  });
});

describe("the gate, in the page (#715)", () => {
  it("draws nothing for a shut gate or an empty carve", () => {
    expect(carveDrawable(null)).toBe(false);
    expect(carveDrawable({ live: false, reason: "no choudoufu roots" })).toBe(false);
    expect(carveDrawable({ live: true, estates: [], migrations: [] })).toBe(false);
    expect(carveDrawable(answer([], [stock]))).toBe(true);
  });
  it("leaves the layer unmounted, with no director and no zoom limit of its own", () => {
    expect(dotsActive()).toBe(false);
    expect(dotsCarving()).toBe(false);
  });
});

// The live local run's cycle 5: the adoption's 82 lines came in one read, all
// within a second. The stock root and the estate it became are one box.
describe("an adoption as one box changing its name", () => {
  const N = 82;
  const addr = (i) => `aws_iam_role.r${String(i).padStart(2, "0")}`;
  const stockRoster = { estate: "terralith", at: at(-120), count: N, resources: Array.from({ length: N }, (_, i) => ({ address: addr(i), type: "aws_iam_role", marked: false })) };
  // As the route gives them: a stamp's empty estate_from reads as the estate it is stamped into.
  const stamps = Array.from({ length: N }, (_, i) => ({ at: at(1), estate_from: "tl5-terralith", estate_to: "tl5-terralith", address: addr(i), ...(i % 2 ? {} : { live_id: `role-${i}` }), outcome: i % 2 ? "skipped" : "stamped" }));
  const adoptM = { name: "adopt", running: true, counts: { moved: 0, stamped: 41, refused: 0, skipped: 41, left: 0 }, lines: stamps };
  const mid = { ...answer([adoptM], [stockRoster]), adopted: [{ from: "terralith", to: "tl5-terralith" }] };

  it("paces a batch of lines 50 ms apart, after any still waiting to play", () => {
    const now = T + 10_000;
    const seen = stampArrivals(mid, new Map(), now);
    const times = stamps.map((l) => seen.get(lineKey("adopt", l))).sort((a, b) => a - b);
    expect(times[0]).toBe(now);
    expect(times[N - 1]).toBe(now + (N - 1) * LIVE.stepMs);
    // A line of the next read waits behind the batch.
    const more = { ...mid, migrations: [{ ...adoptM, lines: [...stamps, { ...stamps[0], at: at(2), address: "aws_s3_bucket.late" }] }] };
    const next = stampArrivals(more, seen, now + 500);
    expect(next.get(lineKey("adopt", { ...stamps[0], at: at(2), address: "aws_s3_bucket.late" }))).toBe(now + N * LIVE.stepMs);
  });

  it("rings the stock root's dots in place, in one box that takes the estate's name with the first stamp", () => {
    const now = T + 10_000;
    const seen = stampArrivals(mid, new Map(), now);
    const show = liveShow(mid, seen, now + N * LIVE.stepMs);
    expect(show.roster).toHaveLength(N);
    expect(show.estates).toEqual(["terralith"]);
    expect(show.events.filter((e) => e.kind === "write")).toHaveLength(0);
    expect(show.events.filter((e) => e.kind === "adopt")).toHaveLength(41);
    expect(boxName(show, "terralith", now - 1)).toBe("terralith");
    expect(boxName(show, "terralith", now)).toBe("tl5-terralith");
  });

  it("after the adoption, draws the estate's roster in the same box, with the same dots", () => {
    const estate = { estate: "tl5-terralith", at: at(12), count: N, resources: stockRoster.resources.map((r, i) => ({ ...r, ...(i % 2 ? {} : { live_id: `role-${i}` }), marked: i % 2 === 0 })) };
    const done = { ...answer([{ ...adoptM, running: false }], [estate]), adopted: [{ from: "terralith", to: "tl5-terralith" }] };
    // A page loaded after it: the lines are the past, the box has the estate's name.
    const show = liveShow(done, stampArrivals(done, new Map(), T + 60_000, { first: true }), T + 60_000);
    expect(show.roster).toHaveLength(N);
    expect(show.estates).toEqual(["terralith"]);
    expect(boxName(show, "terralith", T + 60_000)).toBe("tl5-terralith");
    expect([...show.ownersEnd.values()].every((e) => e === "terralith")).toBe(true);
  });
});

// The live run's cycle 8: after the split, wave 1 writes each team's roster from its plan, with no live ids, so the
// team's resources are named by address only. They are the dots the split's lines moved there, not a second set.
describe("a destination roster written after the move", () => {
  it("joins the moved dots by address, so the team's box holds each resource once", () => {
    const left = { estate: "tl8-terralith", at: at(30), count: 1, resources: [{ address: "aws_vpc.main", type: "aws_vpc", live_id: "vpc-1", marked: true }] };
    const team = { estate: "tl8-team-a", at: at(40), count: 3, resources: ["aws_iam_role.r", "aws_iam_role_policy.p", "aws_cloudwatch_log_group.l"].map((address) => ({ address, type: address.split(".")[0], marked: false })) };
    const mv = (address, o = {}) => ({ at: at(20), estate_from: "tl8-terralith", estate_to: "tl8-team-a", address, outcome: "moved", ...o });
    const splitM = { name: "split", running: false, counts: { moved: 3, stamped: 0, refused: 0, skipped: 0, left: 0 }, lines: [mv("aws_iam_role.r", { live_id: "role-r" }), mv("aws_iam_role_policy.p", { follows: "aws_iam_role.r" }), mv("aws_cloudwatch_log_group.l", { live_id: "logs" })] };
    const a = answer([splitM], [left, team]);
    const show = liveShow(a, stampArrivals(a, new Map(), T + 60_000, { first: true }), T + 60_000);
    expect(show.roster).toHaveLength(4);
    const ends = {};
    for (const e of show.ownersEnd.values()) ends[e] = (ends[e] ?? 0) + 1;
    expect(ends).toEqual({ "tl8-team-a": 3, "tl8-terralith": 1 });
    // They start in the terralith, where the lines say they came from.
    expect(show.owners0.get("aws_iam_role.r")).toBe("tl8-terralith");
  });
});

// The live run's cycle 11: the adoption's stamps, then the split, then wave 1's team rosters with no live ids. The
// boxes read 26 for team rosters of 13: the stamps had made each resource's dot and the team roster made another.
describe("an adoption, a split, and the team rosters written after it", () => {
  it("draws each resource once, so a team's box counts what its roster holds", () => {
    const addrs = ["aws_iam_role.r", "aws_iam_role_policy.p", "aws_cloudwatch_log_group.l"];
    const left = { estate: "tl11-terralith", at: at(30), count: 1, resources: [{ address: "aws_vpc.main", type: "aws_vpc", live_id: "vpc-1", marked: true }] };
    const team = { estate: "tl11-team-a", at: at(40), count: 3, resources: addrs.map((address) => ({ address, type: address.split(".")[0], marked: false })) };
    const ids = { "aws_iam_role.r": "role-r", "aws_iam_role_policy.p": "role-r:p", "aws_cloudwatch_log_group.l": "logs", "aws_vpc.main": "vpc-1" };
    const adoptM = { name: "adopt", running: false, counts: { moved: 0, stamped: 3, refused: 0, skipped: 1, left: 0 }, lines: [...addrs, "aws_vpc.main"].map((address) => ({ at: at(5), estate_from: "tl11-terralith", estate_to: "tl11-terralith", address, live_id: ids[address], outcome: address.includes("policy") ? "skipped" : "stamped" })) };
    const splitM = { name: "split", running: false, counts: { moved: 3, stamped: 0, refused: 0, skipped: 0, left: 0 }, lines: addrs.map((address) => ({ at: at(20), estate_from: "tl11-terralith", estate_to: "tl11-team-a", address, ...(address.includes("policy") ? { follows: "aws_iam_role.r" } : { live_id: ids[address] }), outcome: "moved" })) };
    const a = { ...answer([adoptM, splitM], [left, team]), adopted: [{ from: "terralith", to: "tl11-terralith" }] };
    const show = liveShow(a, stampArrivals(a, new Map(), T + 60_000, { first: true }), T + 60_000);
    expect(show.roster.map((r) => r.address).sort()).toEqual([...addrs, "aws_vpc.main"].sort());
    const ends = {};
    for (const e of show.ownersEnd.values()) ends[e] = (ends[e] ?? 0) + 1;
    expect(ends).toEqual({ "tl11-team-a": 3, terralith: 1 });
  });
});
