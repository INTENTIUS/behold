// behold#571: the Prometheus reader behind the kiosk's "Pipeline metrics".
// The queries are fixed, a viewer's words never reach Prometheus, one read is
// shared for 30 s, and the answer holds what Prometheus returned and no more.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { doraFromFile, METRICS_TTL_MS, metricsRoute, parseVector, prometheusAddress, QUERIES, runOf, type Answers, type Sample } from "./prometheus-metrics.ts";
import { publicReadRefusal } from "./public-mode.ts";

const P = "forgejo:3000/terragucci-admin/demo";
const C1 = "9f3c2a71d04e5b8c6a1f2e3d4c5b6a7980716253";
const C0 = "1111111111111111111111111111111111111111";
const s = (labels: Record<string, string>, value: number): Sample => ({ labels, value });
const w = (commit: string, run: string, wave: string, extra: Record<string, string> = {}) => ({ project: P, commit, run, wave, ...extra });

/** One cycle as terragucci sends it: wave 2 waited in run 4101 and applied in 4102. An older commit's wave 1 beside it. */
function cycle(): Answers {
  return {
    waveSeconds: [s(w(C1, "4101", "1"), 5.36), s(w(C1, "4101", "2"), 4.2), s(w(C1, "4102", "2"), 11.8), s(w(C1, "4102", "3"), 5.6)],
    rootInit: [s(w(C1, "4101", "1", { root: "network" }), 0.163), s(w(C1, "4102", "2", { root: "app" }), 0.171)],
    lockWait: [s({ project: P, commit: C1, run: "4102", root: "app" }, 1.5), s({ project: P, commit: C1, run: "4101", root: "app" }, 9)],
    rootPlan: [s(w(C1, "4101", "1", { root: "network" }), 6.4), s(w(C1, "4101", "2", { root: "app" }), 7.9), s(w(C1, "4102", "2", { root: "app" }), 7.2), s(w(C1, "4102", "3", { root: "edge" }), 5.8), s(w(C0, "4000", "1", { root: "network" }), 9)],
    rootApply: [s(w(C1, "4101", "1", { root: "network" }), 2.1), s(w(C1, "4102", "2", { root: "app" }), 3.4), s(w(C1, "4102", "3", { root: "edge" }), 1.6)],
    held: [s(w(C1, "4102", "2"), 95)],
    changes: [s(w(C1, "4101", "1", { action: "update" }), 1), s(w(C1, "4102", "2", { action: "update" }), 1), s(w(C1, "4102", "2", { action: "create" }), 0), s(w(C1, "4102", "3", { action: "update" }), 1)],
    settled: [s(w(C1, "4101", "1"), 1000), s(w(C1, "4102", "2"), 1200), s(w(C1, "4102", "3"), 1210), s(w(C0, "4000", "1"), 500)],
    waiting: [s(w(C1, "4101", "2"), 1050)],
    deployments: [s({ project: P }, 30), s({ project: "*" }, 41)],
    leadTime: [s({ project: P }, 900)],
    failureRate: [s({ project: P }, 0.1)],
    restore: [],
  };
}

const vector = (result: unknown[]) => ({ status: "success", data: { resultType: "vector", result } });

describe("prometheus-metrics: the queries", () => {
  it("are constant strings over terragucci's gauges, each keeping only the labels behold reads", () => {
    for (const [name, q] of Object.entries(QUERIES)) {
      if (["deployments", "leadTime", "failureRate", "restore"].includes(name)) continue;
      expect(q, name).toMatch(/^max by \([a-z, ]+\) \(last_over_time\(terragucci_[a-z_]+(\{[^}]*\})?\[\d+[hd]\]\)\)$/);
      expect(q, name).not.toMatch(/project=/);
    }
  });

  it("read each DORA gauge's newest value over the week, whichever version's series sent it (behold#571)", () => {
    for (const name of ["deployments", "leadTime", "failureRate", "restore"] as const) {
      expect(QUERIES[name], name).toMatch(/^last_over_time\(\(max by \(project\) \(terragucci_dora_[a-z_]+(\{segment="total"\})?\)\)\[7d:1m\]\)$/);
    }
  });
});

describe("prometheus-metrics: one run's waves", () => {
  it("takes each wave's newest run: the run that applied after the approval, with the time its gate held it", () => {
    const r = runOf(cycle(), "terragucci-admin/demo", C1)!;
    expect(r.commit).toBe(C1);
    expect(r.current).toBe(true);
    expect(r.waves).toEqual([
      { wave: 1, run: "4101", seconds: 5.36, roots: [{ root: "network", init_seconds: 0.163, plan_seconds: 6.4, apply_seconds: 2.1 }], changes: { update: 1 }, settled_at: 1000 },
      { wave: 2, run: "4102", seconds: 11.8, roots: [{ root: "app", init_seconds: 0.171, plan_seconds: 7.2, apply_seconds: 3.4, lock_wait_seconds: 1.5 }], held_seconds: 95, changes: { update: 1 }, settled_at: 1200 },
      { wave: 3, run: "4102", seconds: 5.6, roots: [{ root: "edge", plan_seconds: 5.8, apply_seconds: 1.6 }], changes: { update: 1 }, settled_at: 1210 },
    ]);
  });

  it("a wave still waiting shows when it started waiting, with its plan and no apply", () => {
    const a = cycle();
    a.rootPlan = a.rootPlan.filter((x) => x.labels.run !== "4102");
    for (const k of ["waveSeconds", "rootInit", "rootApply", "held", "changes", "settled"] as const) a[k] = a[k].filter((x) => x.labels.run !== "4102");
    const wave2 = runOf(a, "terragucci-admin/demo", C1)!.waves.find((x) => x.wave === 2)!;
    expect(wave2).toEqual({ wave: 2, run: "4101", seconds: 4.2, roots: [{ root: "app", plan_seconds: 7.9, lock_wait_seconds: 9 }], changes: {}, waiting_since: 1050 });
  });

  it("a commit Prometheus has not seen gives the newest one it has, not marked current; a short id finds its commit", () => {
    expect(runOf(cycle(), "terragucci-admin/demo", "abcdef1")).toMatchObject({ commit: C1, current: false });
    expect(runOf(cycle(), "terragucci-admin/demo", C0.slice(0, 8))).toMatchObject({ commit: C0, current: true, waves: [{ wave: 1, roots: [{ root: "network", plan_seconds: 9 }] }] });
  });

  it("another repo's series are not this repo's, and a repo with none has no run", () => {
    expect(runOf(cycle(), "terragucci-admin/demo-terragrunt")).toBeNull();
    expect(runOf(cycle(), "demo")).toMatchObject({ commit: C1 });
  });

  it("gauges with no commit or run labels read as one run, named by no commit", () => {
    const a = cycle();
    for (const k of Object.keys(a) as (keyof Answers)[]) a[k] = a[k].filter((x) => x.labels.commit !== C0).map((x) => ({ ...x, labels: Object.fromEntries(Object.entries(x.labels).filter(([l]) => l !== "commit" && l !== "run")) }));
    const r = runOf(a, "terragucci-admin/demo")!;
    expect(r.commit).toBeNull();
    expect(r.waves.map((x) => x.wave)).toEqual([1, 2, 3]);
    expect(r.waves[0].run).toBeNull();
  });
});

describe("prometheus-metrics: parsing and the address", () => {
  it("reads an instant vector and leaves out what is not a number", () => {
    expect(parseVector(vector([{ metric: { project: P }, value: [1, "2.5"] }, { metric: {}, value: [1, "NaN"] }, { metric: {}, value: [1, "+Inf"] }]))).toEqual([{ labels: { project: P }, value: 2.5 }]);
    expect(() => parseVector({ status: "error" })).toThrow(/instant vector/);
  });

  it("takes an http or https address with no query", () => {
    expect(prometheusAddress("http://prometheus:9090/")).toBe("http://prometheus:9090");
    expect(prometheusAddress("https://p.example/prom")).toBe("https://p.example/prom");
    expect(prometheusAddress("ftp://p")).toBeUndefined();
    expect(prometheusAddress("http://p/?query=up")).toBeUndefined();
  });
});

describe("prometheus-metrics: dora.json", () => {
  it("gives the repo's four numbers from terragucci estate's file, leaving out a null", () => {
    const doc = { schema: "terragucci.dora/v1", projects: [{ project: P, per_week: 3.5, lead_time: { median_seconds: 4500 }, change_failure: { rate: null }, restore: { median_seconds: 600 } }] };
    expect(doraFromFile(JSON.stringify(doc), "terragucci-admin/demo")).toEqual({ project: P, dora: { from: "dora.json", deployments_per_week: 3.5, lead_time_seconds: 4500, restore_seconds: 600 } });
    expect(doraFromFile(JSON.stringify(doc), "terragucci-admin/other")).toBeNull();
    expect(doraFromFile("not json", "terragucci-admin/demo")).toBeNull();
    expect(doraFromFile(undefined, "terragucci-admin/demo")).toBeNull();
  });
});

describe("prometheus-metrics: GET /api/metrics", () => {
  /** A Prometheus that answers each fixed query from `cycle()`, and counts what it was asked. */
  const prom = (answers: Answers | null = cycle()) => {
    const asked: string[] = [];
    const fetchFn = (async (url: string) => {
      asked.push(url);
      if (!answers) return new Response("down", { status: 503 });
      const q = new URL(url).searchParams.get("query");
      const name = (Object.keys(QUERIES) as (keyof typeof QUERIES)[]).find((n) => QUERIES[n] === q)!;
      return Response.json(vector(answers[name].map((x) => ({ metric: x.labels, value: [0, String(x.value)] }))));
    }) as unknown as typeof fetch;
    return { asked, fetchFn };
  };
  const app = (opts: Parameters<typeof metricsRoute>[1]) => {
    const a = new Hono();
    metricsRoute(a, opts);
    return a;
  };

  it("answers 404 when behold reads no Prometheus", async () => {
    const r = await app({}).request("/api/metrics?project=terragucci-admin/demo");
    expect(r.status).toBe(404);
    expect(((await r.json()) as { code: string }).code).toBe("metrics-off");
  });

  it("refuses a project or a commit that is not one, and asks Prometheus nothing for it", async () => {
    const p = prom();
    const a = app({ prometheus: "http://prom:9090", fetch: p.fetchFn });
    for (const q of ['project=a"}or vector(1)', "project=../x", "project=", "project=a/b&commit=HEAD~1"]) {
      expect((await a.request(`/api/metrics?${q}`)).status, q).toBe(400);
    }
    expect(p.asked).toEqual([]);
  });

  it("gives the run and the DORA numbers, asking only the fixed queries, once per 30 s for every project", async () => {
    const p = prom();
    const a = app({ prometheus: "http://prom:9090", fetch: p.fetchFn, now: () => new Date("2026-10-16T00:00:00Z") });
    const r = await a.request(`/api/metrics?project=terragucci-admin/demo&commit=${C1}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { dora: { restore_seconds?: number } };
    expect(body).toMatchObject({ repo: "terragucci-admin/demo", project: P, run: { commit: C1, current: true }, dora: { from: "prometheus", deployments_per_week: 30, lead_time_seconds: 900, change_failure_ratio: 0.1 } });
    expect(body.dora.restore_seconds).toBeUndefined();
    expect(p.asked.map((u) => new URL(u).searchParams.get("query")).sort()).toEqual(Object.values(QUERIES).sort());
    await a.request("/api/metrics?project=terragucci-admin/demo-terragrunt");
    expect(p.asked).toHaveLength(Object.keys(QUERIES).length);
    expect(METRICS_TTL_MS).toBe(30_000);
  });

  it("with nothing for the project, answers nulls, and reads DORA from dora.json when Prometheus has none", async () => {
    const empty = Object.fromEntries(Object.keys(QUERIES).map((k) => [k, []])) as unknown as Answers;
    const file = JSON.stringify({ projects: [{ project: "forgejo:3000/terragucci-admin/demo-terragrunt", per_week: 2 }] });
    const a = app({ prometheus: "http://prom:9090", fetch: prom(empty).fetchFn, doraFile: async () => file });
    expect(await (await a.request("/api/metrics?project=terragucci-admin/demo")).json()).toMatchObject({ project: null, run: null, dora: null });
    expect(await (await a.request("/api/metrics?project=terragucci-admin/demo-terragrunt")).json()).toMatchObject({ project: "forgejo:3000/terragucci-admin/demo-terragrunt", run: null, dora: { from: "dora.json", deployments_per_week: 2 } });
  });

  it("says so when Prometheus cannot answer, and asks again on the next request", async () => {
    const p = prom(null);
    const a = app({ prometheus: "http://prom:9090", fetch: p.fetchFn });
    const r = await a.request("/api/metrics?project=terragucci-admin/demo");
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toMatch(/Prometheus answered 503/);
    await a.request("/api/metrics?project=terragucci-admin/demo");
    expect(p.asked.length).toBeGreaterThan(Object.keys(QUERIES).length);
  });

  it("is a read a public view keeps", () => {
    expect(publicReadRefusal("/api/metrics", new URLSearchParams("project=terragucci-admin/demo"))).toBeUndefined();
  });
});
