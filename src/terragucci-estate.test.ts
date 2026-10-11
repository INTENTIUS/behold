import { describe, it, expect, afterAll } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configProjects, controlRepo, readControlEstate, runKey, runViewValidator, siblingCheckout, structuralRun } from "./terragucci-estate.ts";
import { terragucciValidator, TerragucciReadError } from "./terragucci-reports.ts";
import { terragucciSource, type TerragucciSource } from "./terragucci-source.ts";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";

// #509: a control repo's estate, from estate.json and each project's run view.
// The fixture holds three projects: shop (its run view named by estate.json's
// run_view, a waiting wave, and a read of network's vpc state), network (its
// run view found from its newest apply commit), and billing (an apply, and no
// run view in the bucket).
const BUCKET = join(import.meta.dirname, "__fixtures__", "terragucci-control");
const SCHEMAS = join(import.meta.dirname, "__fixtures__", "terragucci-schemas");
const SHOP = "d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2";
const NET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const BILL = "f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d";
const SHOP_RUN = `github.com/acme/shop/runs/${SHOP}/run.json`;

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "behold-tg-control-"));
  made.push(d);
  return d;
};
/** A directory with @intentius/terragucci installed, carrying its schemas. */
function withTerragucci(): string {
  const d = scratch();
  const pkg = join(d, "node_modules", "@intentius", "terragucci");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/terragucci", version: "0.4.7", exports: { "./report.schema.json": "./dist/report.schema.json" } }));
  for (const f of ["report.schema.json", "report-index.schema.json", "estate.schema.json", "run.schema.json"]) cpSync(join(SCHEMAS, f), join(pkg, "dist", f));
  return d;
}
const copy = (): string => {
  const d = join(scratch(), "bucket");
  cpSync(BUCKET, d, { recursive: true });
  return d;
};
/** A source that records every key it is asked for. */
function counted(dir: string): { source: TerragucciSource; keys: string[] } {
  const inner = terragucciSource(dir);
  const keys: string[] = [];
  return { keys, source: { ...inner, read: (k) => (keys.push(k), inner.read(k)) } };
}
function repo(files: Record<string, string>, at = scratch()): string {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(at, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return at;
}
const CONTROL_YML = "defaults:\n  binary: tofu\nprojects:\n  github.com/acme/shop: {}\n  github.com/acme/network: {}\n  github.com/acme/billing: {}\n";

describe("readControlEstate (#509)", () => {
  it.each([
    ["terragucci's schemas", () => ({ validator: terragucciValidator([withTerragucci()]), runValidator: runViewValidator([withTerragucci()]) }), "schema"],
    ["the structural check", () => ({ validator: terragucciValidator([scratch()]), runValidator: runViewValidator([scratch()]) }), "structural"],
  ])("draws three projects, the read between them, and the one with no run view, checked with %s", async (_, v, by) => {
    const { source, keys } = counted(BUCKET);
    const e = await readControlEstate(source, "/x/terragucci.yml", { ...v(), configured: ["github.com/acme/shop", "github.com/acme/network", "github.com/acme/billing"] });
    expect(e.validation.estate.by).toBe(by);
    expect(e.validation.run.by).toBe(by);
    expect(e.projects.map((p) => p.project)).toEqual(["github.com/acme/shop", "github.com/acme/network", "github.com/acme/billing"]);

    // One GET per object, and only the objects the bucket page names: no list.
    expect(keys).toEqual(["estate.json", SHOP_RUN, `github.com/acme/network/runs/${NET}/run.json`, `github.com/acme/billing/runs/${BILL}/run.json`]);
    expect(e.gets).toBe(4);

    const [shop, network, billing] = e.projects;
    expect(shop!.run).toMatchObject({ commit: SHOP, from: "run_view", key: SHOP_RUN, page: SHOP_RUN.replace(/json$/, "html"), dated: { key: SHOP_RUN, at: "2026-10-08T09:31:00.000Z" } });
    expect(network!.run).toMatchObject({ commit: NET, from: "apply", dated: { at: "2026-10-07T12:10:00.000Z" } });
    expect(network!.run!.roots.map((r) => [r.root, r.wave])).toEqual([["vpc", 1], ["dns", 2]]);
    expect(billing!.run).toBeUndefined();
    expect(billing!.missing).toBe(`no run view at github.com/acme/billing/runs/${BILL}/run.json`);

    // Every count keeps estate.json's age and source.
    expect(shop!.counts).toEqual({ drifted: 2, failed: 0, waiting: 1, dated: { key: "estate.json", at: "2026-10-08T10:00:00.000Z" } });
    expect(shop!.waiting).toEqual([
      expect.objectContaining({ wave: 2, commit: SHOP, since: "2026-10-08T09:31:00.000Z", age_seconds: 1740, digest: `jcs1-sha256:${"7".repeat(64)}`, command: `npx terragucci approve wave-2 --plan jcs1-sha256:${"7".repeat(64)}`, dated: { key: "estate.json", at: "2026-10-08T10:00:00.000Z" } }),
    ]);

    // The read between projects is matched on the state key, as terragucci's estate graph matches it.
    expect(e.edges.filter((x) => x.cross)).toEqual([{ from: { project: "github.com/acme/network", root: "vpc" }, to: { project: "github.com/acme/shop", root: "envs/prod/app" }, cross: true }]);
    expect(e.edges.filter((x) => !x.cross).map((x) => `${x.from.root}>${x.to.root}`).sort()).toEqual(["envs/prod/app>envs/prod/worker", "vpc>dns"]);
    expect(e.projects.every((p) => p.configured)).toBe(true);
  });

  it("refuses a malformed run view on its project with code terragucci-report, and still draws the others", async () => {
    const d = copy();
    const file = join(d, ...SHOP_RUN.split("/"));
    const doc = JSON.parse(readFileSync(file, "utf8")) as { waves?: unknown };
    delete doc.waves;
    writeFileSync(file, JSON.stringify(doc));
    for (const runValidator of [runViewValidator([withTerragucci()]), runViewValidator([scratch()])]) {
      const e = await readControlEstate(terragucciSource(d), "c", { validator: terragucciValidator([scratch()]), runValidator });
      const shop = e.projects.find((p) => p.project === "github.com/acme/shop")!;
      expect(shop.run).toBeUndefined();
      expect(shop.refused).toMatchObject({ code: "terragucci-report" });
      expect(shop.refused!.error).toContain("terragucci.run/v1");
      expect(shop.waiting[0]!.command).toBe("npx terragucci approve wave-2 --plan <digest>");
      expect(e.projects.find((p) => p.project === "github.com/acme/network")!.run).toBeDefined();
      expect(e.edges.some((x) => x.cross)).toBe(false);
    }
  });

  it("checks a run view against terragucci's run.schema.json when the package resolves", async () => {
    const d = copy();
    const file = join(d, ...SHOP_RUN.split("/"));
    const doc = JSON.parse(readFileSync(file, "utf8")) as { waves: { state: string }[] };
    doc.waves[0]!.state = "exploded";
    writeFileSync(file, JSON.stringify(doc));
    const schema = await readControlEstate(terragucciSource(d), "c", { validator: terragucciValidator([scratch()]), runValidator: runViewValidator([withTerragucci()]) });
    expect(schema.projects[0]!.refused!.error).toContain("run.schema.json rejects it");
    expect(structuralRun(doc)).toBeUndefined();
  });

  it("refuses a run view of another project or commit", async () => {
    const d = copy();
    const file = join(d, ...SHOP_RUN.split("/"));
    const doc = JSON.parse(readFileSync(file, "utf8")) as { project: string };
    doc.project = "github.com/acme/other";
    writeFileSync(file, JSON.stringify(doc));
    const e = await readControlEstate(terragucciSource(d), "c", { validator: terragucciValidator([scratch()]), runValidator: runViewValidator([scratch()]) });
    expect(e.projects[0]!.refused!.error).toContain(`"github.com/acme/other"'s run view`);
  });

  it("refuses the whole read when estate.json is absent or malformed", async () => {
    const empty = scratch();
    const missing = await readControlEstate(terragucciSource(empty), "c").catch((x: unknown) => x);
    expect(missing).toBeInstanceOf(TerragucciReadError);
    expect((missing as TerragucciReadError).refusal).toMatchObject({ code: "terragucci-report" });
    writeFileSync(join(empty, "estate.json"), JSON.stringify({ schema: "terragucci.estate/v2" }));
    const wrong = await readControlEstate(terragucciSource(empty), "c", { validator: terragucciValidator([scratch()]) }).catch((x: unknown) => x);
    expect((wrong as TerragucciReadError).refusal.error).toContain("terragucci.estate/v2");
  });

  it("lists a project the config names and estate.json does not, without dropping it", async () => {
    const e = await readControlEstate(terragucciSource(BUCKET), "c", { configured: ["github.com/acme/shop", "github.com/acme/new"] });
    const fresh = e.projects.find((p) => p.project === "github.com/acme/new")!;
    expect(fresh).toMatchObject({ status: "not-in-estate", configured: true, waiting: [] });
    expect(fresh.missing).toContain("estate.json");
    expect(e.projects.find((p) => p.project === "github.com/acme/network")!.configured).toBe(false);
  });

  it("says how to serve a project checked out beside the control repo", async () => {
    const parent = scratch();
    const control = repo({ ".git/HEAD": "", "terragucci.yml": CONTROL_YML }, join(parent, "control"));
    repo({ ".git/HEAD": "" }, join(parent, "shop"));
    repo({ ".git/HEAD": "" }, join(parent, "network"));
    const projectOf = (dir: string): string | undefined => (dir.endsWith("/shop") ? "github.com/acme/shop" : "github.com/someone/network");
    expect(siblingCheckout("github.com/acme/shop", control, projectOf)).toBe(join(parent, "shop"));
    expect(siblingCheckout("github.com/acme/network", control, projectOf)).toBeUndefined(); // its remote names another project
    const e = await readControlEstate(terragucciSource(BUCKET), "c", { base: control, projectOf });
    expect(e.projects[0]!.checkout).toEqual({ path: join(parent, "shop"), command: `behold serve ${join(parent, "shop")} --terragucci ${BUCKET}` });
    expect(e.projects[1]!.checkout).toBeUndefined();
  });

  it("takes run.json's key from estate.json's page when it is a key under the source", () => {
    expect(runKey({ project: "p/q", run_view: { commit: "c", page: "views/../x/run.html" } }, "c")).toBe("p/q/runs/c/run.json");
    expect(runKey({ project: "p/q", run_view: { commit: "c", page: "https://b.example/p/q/runs/c/run.html" } }, "c")).toBe("p/q/runs/c/run.json");
    expect(runKey({ project: "p/q", run_view: { commit: "c", page: "sub/p/q/runs/c/run.html" } }, "c")).toBe("sub/p/q/runs/c/run.json");
    expect(runKey({ project: "p/q" }, "d")).toBe("p/q/runs/d/run.json");
  });
});

describe("controlRepo (#509)", () => {
  it("is a terragucci config with projects: and no Terraform root", () => {
    const dir = repo({ ".git/HEAD": "", "terragucci.yml": CONTROL_YML });
    expect(controlRepo([dir])).toEqual({ config: join(dir, "terragucci.yml"), projects: ["github.com/acme/shop", "github.com/acme/network", "github.com/acme/billing"] });
    expect(controlRepo([dir], () => 2)).toBeUndefined();
  });

  it("is not a repo whose config has no projects:, nor one without a config", () => {
    expect(controlRepo([repo({ ".git/HEAD": "", "terragucci.yml": "binary: tofu\n" })])).toBeUndefined();
    expect(controlRepo([repo({ ".git/HEAD": "" })])).toBeUndefined();
  });

  it("reads JSON and spots projects: in a terragucci.ts without running it", () => {
    expect(configProjects(join(repo({ "terragucci.json": JSON.stringify({ projects: { "a/b": {} } }) }), "terragucci.json"))).toEqual(["a/b"]);
    expect(configProjects(join(repo({ "terragucci.ts": 'export default {\n  projects: { "a/b": {} },\n};\n' }), "terragucci.ts"))).toEqual([]);
    expect(configProjects(join(repo({ "terragucci.ts": "export default { binary: 'tofu' };\n" }), "terragucci.ts"))).toBeUndefined();
  });
});

describe("GET /api/terragucci/estate (#509)", () => {
  function app(dir: string) {
    const broadcaster = new Broadcaster();
    return createApp({ projectDir: dir, projectDirs: [dir], port: 0, terragucci: { source: BUCKET } }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
  }

  it("answers a control repo's estate, and /api/project names the control repo", async () => {
    const dir = repo({ ".git/HEAD": "", "terragucci.yml": CONTROL_YML });
    const a = app(dir);
    const res = await a.request("/api/terragucci/estate");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { config: string; projects: { project: string; run?: unknown; missing?: string }[]; edges: { cross: boolean }[]; files: string };
    expect(j.config).toBe(join(dir, "terragucci.yml"));
    expect(j.projects).toHaveLength(3);
    expect(j.projects[2]!.missing).toContain("no run view");
    expect(j.edges.filter((e) => e.cross)).toHaveLength(1);
    expect(j.files).toBe("/api/terragucci/file?key=");
    const project = (await (await a.request("/api/project")).json()) as { terragucciControl?: { projects: string[] } };
    expect(project.terragucciControl?.projects).toHaveLength(3);
  });

  it("answers 404 terragucci-not-control for a repo that lists no projects", async () => {
    const res = await app(repo({ ".git/HEAD": "", "terragucci.yml": "binary: tofu\n" })).request("/api/terragucci/estate");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("terragucci-not-control");
  });

  it("is a read: a POST to it is refused on a terragucci repo", async () => {
    const res = await app(repo({ ".git/HEAD": "", "terragucci.yml": CONTROL_YML })).request("/api/terragucci/estate", { method: "POST" });
    expect(res.status).toBe(409);
  });
});
