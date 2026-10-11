import { describe, it, expect } from "vitest";
import { COL_W, countsLine, estateLayout, estateLegend, keyHref, NO_RUN_W, PAD, projectOrder, runLine, waitingRows, wavesOf } from "./terragucci-estate.js";

// #509: the control repo view's layout and words, over an answer shaped like
// /api/terragucci/estate's.
const NOW = new Date("2026-10-08T12:00:00.000Z");
const dated = (at, key = "estate.json") => ({ key, at });
const answer = {
  source: "/b",
  kind: "dir",
  config: "/c/terragucci.yml",
  validation: { estate: { by: "structural" }, run: { by: "schema", terragucci: "0.4.7" } },
  read: NOW.toISOString(),
  estate: { key: "estate.json", html: "estate.html", generated: "2026-10-08T10:00:00.000Z" },
  gets: 4,
  files: "/api/terragucci/file?key=",
  projects: [
    {
      project: "github.com/acme/shop",
      status: "ok",
      index: "github.com/acme/shop/index.html",
      counts: { drifted: 2, failed: 0, waiting: 1, dated: dated("2026-10-08T10:00:00.000Z") },
      waiting: [{ wave: 2, commit: "d3e4f5a6b7c8d9e0", since: "2026-10-08T09:31:00.000Z", age_seconds: 1740, digest: "jcs1-sha256:7777777777777777", command: "npx terragucci approve wave-2 --plan jcs1-sha256:7777777777777777", dated: dated("2026-10-08T10:00:00.000Z") }],
      run: {
        commit: "d3e4f5a6b7c8d9e0",
        updated: "2026-10-08T09:31:00.000Z",
        from: "run_view",
        key: "github.com/acme/shop/runs/d3/run.json",
        page: "github.com/acme/shop/runs/d3/run.html",
        roots: [
          { root: "app", wave: 1, reads: [] },
          { root: "worker", wave: 2, reads: ["app"] },
          { root: "cron", wave: 2, reads: ["app"] },
        ],
        waves: [
          { number: 1, roots: ["app"], reads: [], state: "applied", gate: "wave-1" },
          { number: 2, roots: ["cron", "worker"], reads: [1], state: "waiting", gate: "wave-2" },
        ],
        dated: dated("2026-10-08T09:31:00.000Z", "github.com/acme/shop/runs/d3/run.json"),
      },
      configured: true,
    },
    {
      project: "github.com/acme/network",
      status: "ok",
      counts: { drifted: 0, failed: 0, waiting: 0, dated: dated("2026-10-08T10:00:00.000Z") },
      waiting: [],
      run: { commit: "a1b2", updated: "2026-10-07T12:10:00.000Z", from: "apply", key: "k", page: "p", roots: [{ root: "vpc", wave: 1, reads: [] }], waves: [{ number: 1, roots: ["vpc"], reads: [], state: "applied", gate: "wave-1" }], dated: dated("2026-10-07T12:10:00.000Z", "k") },
      configured: true,
    },
    { project: "github.com/acme/billing", status: "ok", counts: { drifted: 0, failed: 0, waiting: 0, dated: dated("2026-10-08T10:00:00.000Z") }, waiting: [], missing: "no run view at github.com/acme/billing/runs/f0/run.json", configured: true },
    { project: "github.com/acme/legacy", status: "ok", counts: { drifted: 0, failed: 1, waiting: 0, dated: dated("2026-10-08T10:00:00.000Z") }, waiting: [], refused: { error: "k is not a terragucci terragucci.run/v1 document", code: "terragucci-report", remedy: "r" }, configured: false },
  ],
  edges: [
    { from: { project: "github.com/acme/shop", root: "app" }, to: { project: "github.com/acme/shop", root: "worker" }, cross: false },
    { from: { project: "github.com/acme/shop", root: "app" }, to: { project: "github.com/acme/shop", root: "cron" }, cross: false },
    { from: { project: "github.com/acme/network", root: "vpc" }, to: { project: "github.com/acme/shop", root: "app" }, cross: true },
  ],
};

describe("the control repo view (#509)", () => {
  it("puts a project before the projects that read its roots", () => {
    expect(projectOrder(answer).map((p) => p.project)).toEqual(["github.com/acme/network", "github.com/acme/shop", "github.com/acme/billing", "github.com/acme/legacy"]);
  });

  it("lays out one box per project, roots by wave, and keeps a project with no run view as a box", () => {
    const L = estateLayout(answer);
    expect(L.boxes.map((b) => b.project)).toEqual(["github.com/acme/network", "github.com/acme/shop", "github.com/acme/billing", "github.com/acme/legacy"]);
    const shop = L.boxes[1];
    expect(shop.w).toBe(2 * COL_W + 2 * PAD);
    expect(shop.waves.map((w) => [w.number, w.state, w.roots.map((r) => r.root)])).toEqual([
      [1, "applied", ["app"]],
      [2, "waiting", ["cron", "worker"]],
    ]);
    expect(L.boxes[2].waves).toEqual([]);
    expect(L.boxes[2].w).toBe(NO_RUN_W);
    // Boxes do not overlap, and the cross edge runs left to right.
    for (let i = 1; i < L.boxes.length; i++) expect(L.boxes[i].x).toBeGreaterThan(L.boxes[i - 1].x + L.boxes[i - 1].w);
    expect(L.edges).toHaveLength(3);
    const cross = L.edges.find((e) => e.cross);
    const n = cross.d.match(/-?[\d.]+/g).map(Number);
    expect(n[6]).toBeGreaterThan(n[0]); // the end's x is right of the start's
    expect(L.width).toBeGreaterThan(L.boxes[3].x + L.boxes[3].w);
  });

  it("skips an edge to a root no box draws", () => {
    const L = estateLayout({ ...answer, edges: [{ from: { project: "github.com/acme/billing", root: "x" }, to: { project: "github.com/acme/shop", root: "app" }, cross: true }] });
    expect(L.edges).toEqual([]);
  });

  it("dates every count and run view, and says when a project has none", () => {
    const shop = answer.projects[0];
    expect(countsLine(shop, NOW)).toEqual({ text: "2 roots drifted · 0 failed · 1 wave waiting · 2h ago", title: "from estate.json, generated 10:00 UTC (2h ago); not live" });
    expect(runLine(shop, NOW).text).toBe("run view d3e4f5a6b7c8 · updated 2h ago");
    expect(runLine(answer.projects[2], NOW)).toMatchObject({ text: "no run view", tone: "none" });
    expect(runLine(answer.projects[3], NOW)).toMatchObject({ text: "run view refused", tone: "bad" });
    expect(countsLine({ status: "not-in-estate", missing: "m" }, NOW).text).toBe("not in estate.json");
  });

  it("offers a waiting wave's approve line to copy, with its age", () => {
    expect(waitingRows(answer.projects[0], NOW)).toEqual([
      { text: "wave 2 waiting since 09:31 UTC, 2h ago · commit d3e4f5a6b7c8 · plan 777777777777", title: "from estate.json, generated 10:00 UTC", command: "npx terragucci approve wave-2 --plan jcs1-sha256:7777777777777777", digestKnown: true, report: undefined },
    ]);
  });

  it("says whose estate, how old and how checked, and opens keys through the file route", () => {
    const lg = estateLegend(answer, NOW);
    expect(lg.text).toBe("terragucci estate of 4 projects, not live · estate.json generated 2h ago · 2 drawn from a run view · 1 read between projects");
    expect(lg.title).toContain("4 GETs");
    expect(lg.title).toContain("terragucci 0.4.7's schema");
    expect(keyHref(answer, "github.com/acme/shop/index.html")).toBe("/api/terragucci/file?key=github.com%2Facme%2Fshop%2Findex.html");
    expect(wavesOf({ waves: [{ number: 3 }], roots: [{ wave: 1 }] })).toEqual([1, 3]);
  });
});
