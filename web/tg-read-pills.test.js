import { describe, expect, it } from "vitest";
import { FLASH_MAX, FLASH_MS, coveredEdges, createReadFlash, dependsLine, hotReads, nearestOn, pillSpots, readKey, readerStates } from "./tg-read-pills.js";

// behold#744: the tofu fan-out's reads: cluster-a and cluster-b read network; app-01..06 read cluster-a.
const apps = ["app-01", "app-02", "app-03", "app-04", "app-05", "app-06"];
const edges = [
  { from: "cluster-a", to: "network" },
  { from: "cluster-b", to: "network" },
  ...apps.map((a) => ({ from: a, to: "cluster-a" })),
];
const clock = () => {
  let t = 1000;
  return { now: () => t, tick: (ms) => (t += ms) };
};
const states = (over) => Object.fromEntries([["cluster-a", "applied"], ["cluster-b", "applied"], ...apps.map((a) => [a, "not-started"]), ...Object.entries(over)]);

describe("which reads flash on a kiosk (behold#744)", () => {
  it("shows nothing for a run first seen settled, nor while nothing moves", () => {
    const c = clock();
    const f = createReadFlash({ now: c.now });
    expect(f.live(edges, states({}))).toEqual([]);
    c.tick(500);
    expect(f.live(edges, states({}))).toEqual([]);
  });

  it("shows a reader's reads once its wave applies it, and lets them go after the hold", () => {
    const c = clock();
    const f = createReadFlash({ now: c.now });
    f.live(edges, states({ "cluster-a": "not-started", "cluster-b": "not-started" }));
    c.tick(100);
    const now = f.live(edges, states({ "cluster-a": "applying", "cluster-b": "applying" }));
    expect(now.map((x) => x.key)).toEqual([readKey(edges[0]), readKey(edges[1])]);
    expect(now.every((x) => x.age === 0)).toBe(true);
    c.tick(2000);
    expect(f.live(edges, states({ "cluster-a": "applying", "cluster-b": "applying" })).map((x) => x.age)).toEqual([2000, 2000]);
    c.tick(FLASH_MS);
    expect(f.live(edges, states({ "cluster-a": "applying", "cluster-b": "applying" }))).toEqual([]);
  });

  it("shows what a reloaded frame finds on first sight, the failed reader's read first, then applying, then blocked", () => {
    const c = clock();
    const f = createReadFlash({ now: c.now });
    const shown = f.live(edges, states({ "cluster-a": "failed", "app-01": "blocked", "app-02": "blocked", "cluster-b": "applying" })).map((x) => x.key);
    expect(shown).toEqual([readKey(edges[0]), readKey(edges[1]), readKey({ from: "app-01", to: "cluster-a" })]);
  });

  it("shows a read again when its reader fails or is blocked after it was seen", () => {
    const c = clock();
    const f = createReadFlash({ now: c.now });
    f.live(edges, states({ "cluster-a": "applying" }));
    c.tick(FLASH_MS + 1);
    expect(f.live(edges, states({ "cluster-a": "applying" }))).toEqual([]);
    c.tick(10);
    expect(f.live(edges, states({ "cluster-a": "failed", "app-01": "blocked" })).map((x) => x.key)).toEqual([readKey({ from: "cluster-a", to: "network" }), readKey({ from: "app-01", to: "cluster-a" })]);
  });

  it("never shows more than a handful at once, the newest first", () => {
    const c = clock();
    const f = createReadFlash({ now: c.now });
    f.live(edges, states({}));
    c.tick(10);
    f.live(edges, states({ "app-01": "applying" }));
    c.tick(10);
    const all = Object.fromEntries(apps.map((a) => [a, "applying"]));
    const shown = f.live(edges, states(all));
    expect(shown.length).toBe(FLASH_MAX);
    expect(shown.map((x) => x.key)).not.toContain(readKey({ from: "app-01", to: "cluster-a" }));
  });
});

describe("the reads a pointer lights (behold#744)", () => {
  it("lights a reader's reads and the reads of the root it reads; a line lights itself alone", () => {
    expect(hotReads(edges, { root: "app-03" })).toEqual([readKey({ from: "app-03", to: "cluster-a" })]);
    expect(hotReads(edges, { root: "network" })).toEqual([readKey(edges[0]), readKey(edges[1])]);
    expect(hotReads(edges, { root: "cluster-a" })).toHaveLength(7);
    expect(hotReads(edges, { key: readKey(edges[1]) })).toEqual([readKey(edges[1])]);
    expect(hotReads(edges, { key: "nope" })).toEqual([]);
    expect(hotReads(edges, {})).toEqual([]);
  });

  it("reads each reader's state from the components zoom's cards first, then the root states", () => {
    expect(readerStates({ cards: { "app-01": { root: "app-01", wave: 3, state: "blocked" } }, waves: {} }, { "app-01": { state: "not-started" }, network: { state: "applied" } })).toEqual({ "app-01": "blocked", network: "applied" });
    expect(readerStates(null, null)).toEqual({});
  });

  it("reads a planned card applying while its wave's job runs, and leaves an unchanged one be", () => {
    const marks = {
      cards: { "cluster-a": { root: "cluster-a", wave: 2, state: "planned" }, "cluster-b": { root: "cluster-b", wave: 2, state: "unchanged" }, "app-01": { root: "app-01", wave: 3, state: "planned" } },
      waves: { 2: { status: { status: "running" } }, 3: { status: { status: "queued" } } },
    };
    expect(readerStates(marks, null)).toEqual({ "cluster-a": "applying", "cluster-b": "unchanged", "app-01": "planned" });
  });
});

describe("where a pill goes (behold#744)", () => {
  const card = { x: 100, y: 100, x2: 260, y2: 160 };
  it("tries the side the line leaves from first, touching the card, and the nearest spot is beside p0", () => {
    const p0 = { x: 180, y: 160 }; // the card's bottom border
    const spots = pillSpots(card, p0, 200, 23);
    expect(spots[0].side).toBe("bottom");
    expect(spots[0].r.y).toBe(166);
    expect(spots[0].far).toBeCloseTo(6);
    const nearest = [...spots].sort((a, b) => a.far - b.far)[0];
    expect(nearest.side).toBe("bottom");
    // None of them sits on the card.
    for (const s of spots) expect(s.r.x2 <= card.x || s.r.x >= card.x2 || s.r.y2 <= card.y || s.r.y >= card.y2).toBe(true);
  });

  it("goes beside a card's left side for a line that leaves it there", () => {
    expect(pillSpots(card, { x: 100, y: 130 }, 120, 23)[0]).toMatchObject({ side: "left", r: { x2: 94 } });
  });

  it("meets the pill's nearest edge with its leader", () => {
    expect(nearestOn({ x: 0, y: 0, x2: 10, y2: 10 }, { x: 5, y: 20 })).toEqual({ x: 5, y: 10 });
    expect(nearestOn({ x: 0, y: 0, x2: 10, y2: 10 }, { x: -4, y: -4 })).toEqual({ x: 0, y: 0 });
  });
});

describe("a read line stands for the dependency edge on its pair (behold#762)", () => {
  // The tofu fan-out's dependency edges as pinhole draws them: each app on its cluster, each cluster on network.
  const deps = [
    { from: "cluster-a", to: "network" },
    { from: "cluster-b", to: "network" },
    ...apps.map((a) => ({ from: a, to: "cluster-a" })),
  ];

  it("covers every edge whose pair has a read, and names the read", () => {
    expect(coveredEdges(edges, deps)).toEqual(deps.map((d) => readKey(d)));
  });

  it("leaves an edge with no read on its pair to draw itself", () => {
    const reads = edges.filter((e) => e.from !== "app-03" && e.to !== "network");
    const out = coveredEdges(reads, deps);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[deps.findIndex((d) => d.from === "app-03")]).toBeNull();
    expect(out.filter(Boolean)).toHaveLength(5);
  });

  it("matches the pair in either direction", () => {
    expect(coveredEdges([{ from: "app-01", to: "cluster-a" }], [{ from: "cluster-a", to: "app-01" }])).toEqual(["app-01→cluster-a"]);
  });

  it("matches a read named by its root's path to a card named after the root, and no other card", () => {
    const reads = [{ from: "apps/app-01", to: "clusters/cluster-a" }];
    expect(coveredEdges(reads, [{ from: "app-01", to: "cluster-a" }, { from: "app-1", to: "cluster-a" }, { from: "pp-01", to: "cluster-a" }])).toEqual(["apps/app-01→clusters/cluster-a", null, null]);
  });

  it("covers nothing without reads (a chant repo) or without edges", () => {
    expect(coveredEdges([], deps)).toEqual(deps.map(() => null));
    expect(coveredEdges(undefined, deps)).toEqual(deps.map(() => null));
    expect(coveredEdges(edges, [])).toEqual([]);
  });

  it("says what the hidden edge meant", () => {
    expect(dependsLine({ from: "app-01", to: "cluster-a" })).toBe("app-01 → cluster-a\napp-01 depends on cluster-a, so cluster-a applies first");
  });
});
