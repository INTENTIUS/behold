import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { allowedWrite, READ_METHODS, refusedWrite, terragucciConfig, TERRAGUCCI_ALLOWED_WRITES, TERRAGUCCI_REFUSED_WRITES } from "./terragucci-repo.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-tg-"));
  made.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function app(projectDir: string, extra: { carveReport?: string; terragucci?: { source: string } } = {}) {
  const broadcaster = new Broadcaster();
  return createApp({ projectDir, port: 0, ...extra }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir, broadcaster, onDone: () => {} }));
}

describe("terragucciConfig (#489)", () => {
  it("finds terragucci.yml in the served directory", () => {
    const dir = repo({ ".git/HEAD": "", "terragucci.yml": "binary: tofu\n" });
    expect(terragucciConfig(dir)).toBe(join(dir, "terragucci.yml"));
  });

  it("finds it above a served subdirectory, up to the git root", () => {
    const dir = repo({ ".git/HEAD": "", "terragucci.yaml": "", "envs/prod/main.tf": "" });
    expect(terragucciConfig(join(dir, "envs/prod"))).toBe(join(dir, "terragucci.yaml"));
  });

  it("does not look past the git root", () => {
    const dir = repo({ "terragucci.yml": "", "inner/.git/HEAD": "", "inner/main.tf": "" });
    expect(terragucciConfig(join(dir, "inner"))).toBeUndefined();
  });

  it("is undefined for a repo without one", () => {
    expect(terragucciConfig(repo({ ".git/HEAD": "", "main.tf": "" }))).toBeUndefined();
  });
});

describe("a terragucci repo refuses every write that deploys, approves or starts a run (#489)", () => {
  const writes = [
    "/api/apply?env=prod",
    "/api/local/reset",
    "/api/ops/prod-apply/run",
    "/api/ops/prod-apply/signal/approve",
    "/api/operator/approve/prod-apply/approve",
    "/api/workspace/gates/approve",
    "/api/substrates/floci/up",
    "/api/ci/dispatch?env=prod",
    "/api/ci/readopt",
    "/api/rollback?to=HEAD~1",
  ];

  it.each(writes)("POST %s answers 409 terragucci, naming the pipeline", async (path) => {
    const dir = repo({ ".git/HEAD": "", "terragucci.yml": "binary: tofu\n" });
    const res = await app(dir).request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string; remedy: string };
    expect(body.code).toBe("terragucci");
    expect(body.error).toContain("applied by its pipeline only");
    expect(body.remedy).toContain("npx terragucci approve wave-<k> --plan <digest>");
    expect(body.remedy).toContain("gate card");
  });

  it("refuses from a served subdirectory of the repo too", async () => {
    const dir = repo({ ".git/HEAD": "", "terragucci.yml": "", "envs/prod/main.tf": "" });
    const res = await app(join(dir, "envs/prod")).request("/api/apply?env=prod", { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("terragucci");
  });

  it("leaves a repo without terragucci alone", async () => {
    const dir = repo({ ".git/HEAD": "" });
    const res = await app(dir).request("/api/apply", { method: "POST" });
    expect(((await res.json()) as { code?: string }).code).not.toBe("terragucci");
  });

  it("tells the page, so it offers no Deploy", async () => {
    const dir = repo({ ".git/HEAD": "", "terragucci.yml": "" });
    const project = (await (await app(dir).request("/api/project")).json()) as { terragucci?: { config: string; code: string } };
    expect(project.terragucci?.config).toBe(join(dir, "terragucci.yml"));
    expect(project.terragucci?.code).toBe("terragucci");
  });

  // #500: the boundary is an allowlist. Every write route the real app
  // registers, in each shape createApp takes (plain, a carve report, a
  // terragucci source), is either refused on a terragucci repo or named in
  // TERRAGUCCI_ALLOWED_WRITES. A refused one is asked for real and must answer
  // 409; an allowed one is not sent, since it would do what it does.
  it("refuses every registered write route that is not on the allowlist, whatever its method", async () => {
    const dir = repo({ ".git/HEAD": "", "terragucci.yml": "binary: tofu\n", "report.json": "{}" });
    const shapes = [app(dir), app(dir, { carveReport: join(dir, "report.json") }), app(dir, { terragucci: { source: dir } })];
    const writes = new Map<string, { method: string; path: string; app: ReturnType<typeof app> }>();
    for (const a of shapes) {
      for (const r of a.routes) {
        // app.use() middleware is registered as ALL on a wildcard path; no handler is.
        if (r.method === "ALL" && r.path.includes("*")) continue;
        if (READ_METHODS.has(r.method)) continue;
        const path = r.path.replace(/:[A-Za-z]+/g, "x");
        writes.set(`${r.method} ${path}`, { method: r.method, path, app: a });
      }
    }
    expect(writes.size).toBeGreaterThan(TERRAGUCCI_ALLOWED_WRITES.length);
    const allowed: string[] = [];
    for (const [name, w] of writes) {
      if (allowedWrite(w.method, w.path)) {
        allowed.push(name);
        continue;
      }
      const method = w.method === "ALL" ? "POST" : w.method;
      const res = await w.app.request(w.path, { method, headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status, name).toBe(409);
      expect(((await res.json()) as { code: string }).code, name).toBe("terragucci");
    }
    // Every allowlist entry names a route the app registers: no stale entry
    // that would let a future route of the same path through unseen.
    expect(allowed.sort()).toEqual(TERRAGUCCI_ALLOWED_WRITES.map((w) => `${w.method} ${w.pattern.source.replace(/^\^|\$$/g, "").replace(/\\\//g, "/")}`).sort());
  });

  it.each(["PUT", "PATCH", "DELETE", "POST"])("refuses a %s to a route nobody listed, even one registered after the boundary", async (method) => {
    const dir = repo({ ".git/HEAD": "", "terragucci.yml": "" });
    const a = app(dir);
    let reached = false;
    a.on(method, "/api/not-yet-written", (c) => {
      reached = true;
      return c.json({ ok: true });
    });
    const res = await a.request("/api/not-yet-written", { method });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("terragucci");
    expect(body.error).toContain(`${method} /api/not-yet-written`);
    expect(reached).toBe(false);
  });

  it("keeps the known writes' wording, and lets reads and the allowlist through", () => {
    expect(refusedWrite("POST", "/api/apply")).toBe("apply");
    expect(refusedWrite("POST", "/api/ops/a/signal/b")).toBe("signalling an Op's gate");
    expect(refusedWrite("DELETE", "/api/apply")).toBe("DELETE /api/apply");
    expect(refusedWrite("PUT", "/api/layout")).toBe("PUT /api/layout");
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) expect(refusedWrite(m, "/api/apply")).toBeUndefined();
    for (const w of TERRAGUCCI_ALLOWED_WRITES) expect(refusedWrite(w.method, w.pattern.source.replace(/^\^|\$$/g, "").replace(/\\\//g, "/"))).toBeUndefined();
    expect(TERRAGUCCI_REFUSED_WRITES.every((w) => !allowedWrite("POST", w.pattern.source))).toBe(true);
  });
});
