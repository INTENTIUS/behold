import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { idHex, MAX_SPANS, searchIds, searchQuery, tempoAddress, tracesRoute, trimTrace } from "./tempo-traces.ts";

const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
const kv = (key: string, v: string | number) => ({ key, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: v } });
const T0 = 1_792_166_000_000_000_000n;
const span = (id: string, parent: string | null, name: string, fromMs: number, toMs: number, attrs: [string, string | number][] = [], error = false) => ({
  traceId: b64("11".repeat(16)),
  spanId: b64(id.padStart(16, "0")),
  ...(parent ? { parentSpanId: b64(parent.padStart(16, "0")) } : {}),
  name,
  startTimeUnixNano: String(T0 + BigInt(fromMs) * 1_000_000n),
  endTimeUnixNano: String(T0 + BigInt(toMs) * 1_000_000n),
  attributes: attrs.map(([k, v]) => kv(k, v)),
  status: error ? { code: 2, message: "exit 1" } : { code: 1 },
});

/** A wave's trace as Tempo's /api/v2/traces answers it: terragucci's batch and OpenTofu's. */
function waveTrace(opts: { project?: string; job?: string; run?: string } = {}) {
  return {
    trace: {
      resourceSpans: [
        {
          resource: { attributes: [kv("service.name", "terragucci"), kv("terragucci.project", opts.project ?? "forgejo:3000/terragucci-admin/demo"), kv("vcs.ref.head.revision", "ab".repeat(20)), kv("cicd.pipeline.run.id", opts.run ?? "4184"), kv("cicd.pipeline.task.name", opts.job ?? "apply-wave-1")] },
          scopeSpans: [{ spans: [
            span("1", null, "terragucci tf-apply", 0, 1000, [["terragucci.stage", "tf-apply"], ["terragucci.wave", 1], ["terragucci.result", "applied"], ["terragucci.change_set", "secret-ish"]]),
            span("2", "1", "plan", 100, 400, [["terragucci.phase", "plan"]]),
            span("3", "2", "root network", 110, 390, [["terragucci.root", "network"]]),
            span("4", "3", "tofu plan", 120, 380, [["process.command_args", "plan -out=/tmp/x"]]),
            span("5", "1", "gate", 400, 800, [["terragucci.phase", "gate"], ["terragucci.gate.status", "approved"], ["terragucci.gate.held_seconds", 40]]),
            span("6", "1", "apply", 800, 950, [["terragucci.phase", "apply"]], true),
          ] }],
        },
        {
          resource: { attributes: [kv("service.name", "OpenTofu CLI"), kv("process.owner", "someone")] },
          scopeSpans: [{ spans: [span("7", "4", "Plan resource instance changes", 200, 300, [["opentofu.resource_instance.address", "terraform_data.release"], ["opentofu.plan.refresh", 1]])] }],
        },
      ],
    },
  };
}

describe("searchQuery: the one TraceQL behold asks", () => {
  it("searches terragucci's traces by run id or by commit, the attribute names quoted", () => {
    expect(searchQuery({ run: "4184" })).toBe('{ resource.service.name = "terragucci" && resource."cicd.pipeline.run.id" = "4184" }');
    expect(searchQuery({ commit: "ab".repeat(20) })).toBe(`{ resource.service.name = "terragucci" && resource."vcs.ref.head.revision" = "${"ab".repeat(20)}" }`);
    expect(searchQuery({ commit: "abc1234" })).toBe('{ resource.service.name = "terragucci" && resource."vcs.ref.head.revision" =~ "abc1234.*" }');
  });

  it("takes only digits for a run and hex for a commit", () => {
    expect(() => searchQuery({ run: '1" || true || "' })).toThrow();
    expect(() => searchQuery({ run: "0" })).toThrow();
    expect(() => searchQuery({ commit: "zz12345" })).toThrow();
  });
});

describe("trimTrace", () => {
  it("draws one job: its stage, wave, result and job, each span with its parent and the attributes the view reads", () => {
    const t = trimTrace("11".repeat(16), waveTrace(), "terragucci-admin/demo")!;
    expect(t).toMatchObject({ job: "apply-wave-1", stage: "tf-apply", wave: 1, result: "applied", commit: "ab".repeat(20), project: "forgejo:3000/terragucci-admin/demo", ms: 1000, left_out: 0 });
    expect(t.spans.map((s) => s.name)).toEqual(["terragucci tf-apply", "plan", "root network", "tofu plan", "Plan resource instance changes", "gate", "apply"]);
    const byName = Object.fromEntries(t.spans.map((s) => [s.name, s]));
    expect(byName["plan"]!.parent).toBe("0000000000000001");
    expect(byName["Plan resource instance changes"]).toMatchObject({ parent: "0000000000000004", service: "OpenTofu CLI", ms: 100, attrs: { "opentofu.resource_instance.address": "terraform_data.release" } });
    expect(byName["gate"]!.attrs).toEqual({ "terragucci.phase": "gate", "terragucci.gate.status": "approved", "terragucci.gate.held_seconds": 40 });
    expect(byName["apply"]!.error).toBe("exit 1");
    // Only the kept attributes leave behold: no command line, no change set, no resource attributes.
    expect(byName["terragucci tf-apply"]!.attrs).not.toHaveProperty("terragucci.change_set");
    expect(byName["tofu plan"]!.attrs).toEqual({});
    expect(JSON.stringify(t)).not.toContain("someone");
  });

  it("keeps a trace of another repo out", () => {
    expect(trimTrace("11".repeat(16), waveTrace({ project: "forgejo:3000/someone/else" }), "terragucci-admin/demo")).toBeNull();
    expect(trimTrace("11".repeat(16), { trace: {} }, "terragucci-admin/demo")).toBeNull();
  });

  it("past the span budget leaves out the deepest spans and counts them", () => {
    const t = trimTrace("11".repeat(16), waveTrace(), "terragucci-admin/demo", 4)!;
    expect(t.spans.map((s) => s.name)).toEqual(["terragucci tf-apply", "plan", "gate", "apply"]);
    expect(t.left_out).toBe(3);
    expect(MAX_SPANS).toBeGreaterThan(1000);
  });

  it("reads ids in hex or base64", () => {
    expect(idHex("00000000000000ff")).toBe("00000000000000ff");
    expect(idHex(b64("00000000000000ff"))).toBe("00000000000000ff");
    expect(idHex("")).toBeNull();
  });
});

describe("searchIds", () => {
  it("lists the traces a search found, oldest first", () => {
    expect(searchIds({ traces: [{ traceID: "b2", startTimeUnixNano: "2000" }, { traceID: "a1", startTimeUnixNano: "1000" }, { traceID: "nope!" }] })).toEqual(["a1".padStart(32, "0"), "b2".padStart(32, "0")]);
    expect(searchIds(null)).toEqual([]);
  });
});

describe("GET /api/traces", () => {
  const serve = (tempo: string | undefined, answer: (url: string) => { status: number; body: unknown }) => {
    const asked: string[] = [];
    const app = new Hono();
    const fetchFn = (async (url: string) => {
      asked.push(url);
      const a = answer(url);
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    tracesRoute(app, { ...(tempo ? { tempo } : {}), fetch: fetchFn, now: () => new Date("2026-10-16T12:00:00Z") });
    return { app, asked };
  };
  const tempo = (url: string) =>
    url.includes("/api/search")
      ? { status: 200, body: { traces: [{ traceID: "22".repeat(16), startTimeUnixNano: "2" }, { traceID: "11".repeat(16), startTimeUnixNano: "1" }] } }
      : url.endsWith("22".repeat(16))
        ? { status: 200, body: waveTrace({ job: "apply-wave-2" }) }
        : { status: 200, body: waveTrace() };

  it("answers 404 with no Tempo", async () => {
    const { app } = serve(undefined, tempo);
    const r = await app.request("/api/traces?project=terragucci-admin/demo&run=4184");
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ code: "traces-off" });
  });

  it("refuses what is not a repo, a run id, a commit or a job name, and asks Tempo nothing", async () => {
    const { app, asked } = serve("http://tempo:3200", tempo);
    for (const q of ["project=a/b/c/d&run=1", "project=terragucci-admin/demo&run=1%22%7D", "project=terragucci-admin/demo&commit=xyz", "project=terragucci-admin/demo", "project=terragucci-admin/demo&run=1&job=%7Bx%7D"]) {
      expect((await app.request(`/api/traces?${q}`)).status, q).toBe(400);
    }
    expect(asked).toEqual([]);
  });

  it("searches by the run, fetches each trace, and answers the run's jobs, one job's trace when asked", async () => {
    const { app, asked } = serve("http://tempo:3200", tempo);
    const r = await app.request("/api/traces?project=terragucci-admin/demo&run=4184&job=apply-wave-2");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { jobs: string[]; traces: { job: string }[]; project: string; run: string };
    expect(body.jobs).toEqual(["apply-wave-1", "apply-wave-2"]);
    expect(body.traces.map((t) => t.job)).toEqual(["apply-wave-2"]);
    expect(body).toMatchObject({ project: "forgejo:3000/terragucci-admin/demo", run: "4184" });
    const q = new URL(asked[0]!).searchParams.get("q");
    expect(q).toBe(searchQuery({ run: "4184" }));
    expect(asked.slice(1).sort()).toEqual([`http://tempo:3200/api/v2/traces/${"11".repeat(16)}`, `http://tempo:3200/api/v2/traces/${"22".repeat(16)}`]);
    // A second kiosk within the shared window asks Tempo nothing more.
    await app.request("/api/traces?project=terragucci-admin/demo&run=4184");
    expect(asked).toHaveLength(3);
  });

  it("says when Tempo cannot answer", async () => {
    const { app } = serve("http://tempo:3200", () => ({ status: 500, body: {} }));
    const r = await app.request("/api/traces?project=terragucci-admin/demo&run=4184");
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ code: "traces-read" });
  });

  it("takes an address with no query", () => {
    expect(tempoAddress("http://tempo:3200/")).toBe("http://tempo:3200");
    expect(tempoAddress("http://tempo:3200/?q=1")).toBeUndefined();
    expect(tempoAddress("file:///x")).toBeUndefined();
  });
});
