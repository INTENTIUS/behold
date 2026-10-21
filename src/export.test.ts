import { describe, it, expect } from "vitest";
import { bundleIdentity, canonicalKey, captureKeys, copyNotices, OPENING_ZOOMS, settleOpening, workerName } from "./export.ts";

describe("canonicalKey", () => {
  it("is independent of param order (sorted by the lens whitelist)", () => {
    const a = canonicalKey("/api/overlay", new URLSearchParams("env=local&detail=2"));
    const b = canonicalKey("/api/overlay", new URLSearchParams("detail=2&env=local"));
    expect(a).toBe(b);
    expect(a).toBe("/api/overlay?detail=2&env=local");
  });

  it("keeps only the whitelisted lens params (drops target/lens/etc.)", () => {
    const k = canonicalKey("/api/overlay", new URLSearchParams("detail=2&env=local&target=http://x&lens=y&radial=1"));
    expect(k).toBe("/api/overlay?detail=2&env=local&radial=1");
  });

  it("returns the bare path when no lens params are present", () => {
    expect(canonicalKey("/api/project", new URLSearchParams())).toBe("/api/project");
  });

  // #228: runExport appends `layout=1` to every capture request so the graph
  // routes bake the hand-layout sidecar into the snapshot SVGs. It is not a
  // lens (it doesn't select a distinct snapshot — it's how the ONE snapshot is
  // rendered), so it must not reach the key the frontend will look up.
  it("drops layout=1 — the bake changes the SVG, not which snapshot you want", () => {
    expect(canonicalKey("/api/graph", new URLSearchParams("components=1&layout=1"))).toBe("/api/graph?components=1");
    expect(canonicalKey("/api/project", new URLSearchParams("layout=1"))).toBe("/api/project");
  });

  it("drops detail/radial for the components view (the frontend appends them, the DAG ignores them)", () => {
    // load() always sends the current detail even in the components view.
    const k = canonicalKey("/api/graph", new URLSearchParams("components=1&detail=3&env=local&radial=1"));
    expect(k).toBe("/api/graph?components=1&env=local");
  });

  it("drops detail/radial for the logical view too (re-projected at detail 3, dial ignored)", () => {
    const k = canonicalKey("/api/overlay", new URLSearchParams("logical=1&detail=3&env=local&radial=1"));
    expect(k).toBe("/api/overlay?env=local&logical=1");
  });
});

describe("captureKeys", () => {
  const keys = captureKeys({ environments: ["local", "prod"], tiers: [] });

  it("always captures the globals", () => {
    for (const g of ["/api/project", "/api/substrates", "/api/ops"]) expect(keys).toContain(g);
  });

  it("captures the source view (no env) and each declared env", () => {
    expect(keys).toContain("/api/graph?components=1"); // source components
    expect(keys).toContain("/api/graph?components=1&env=local");
    expect(keys).toContain("/api/graph?components=1&env=prod");
  });

  it("captures the logical lens — source graph for no-env, overlay per env (#63)", () => {
    expect(keys).toContain("/api/graph?logical=1"); // source (no env)
    expect(keys).toContain("/api/overlay?env=local&logical=1");
    expect(keys).toContain("/api/overlay?env=prod&logical=1");
  });

  it("captures overlay for each env × detail × radial, and source graph for no-env", () => {
    expect(keys).toContain("/api/overlay?detail=2&env=local");
    expect(keys).toContain("/api/overlay?detail=2&env=local&radial=1");
    expect(keys).toContain("/api/overlay?detail=3&env=prod&radial=1");
    // source (no env) uses /api/graph, not /api/overlay
    expect(keys).toContain("/api/graph?detail=1");
    expect(keys).toContain("/api/graph?detail=1&radial=1");
    expect(keys.some((k) => k.startsWith("/api/overlay") && !k.includes("env="))).toBe(false);
  });

  it("captures reconcile + resources + bulk diff only when an env is set", () => {
    expect(keys).toContain("/api/reconcile?env=local");
    expect(keys).toContain("/api/resources?env=local");
    expect(keys).toContain("/api/diff?env=local"); // bulk per-node live state
    // no env-less reconcile/diff
    expect(keys).not.toContain("/api/reconcile");
    expect(keys).not.toContain("/api/diff");
  });

  it("has no duplicate keys", () => {
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("multiplies by tiers when the project has them", () => {
    const withTiers = captureKeys({ environments: ["local"], tiers: ["light", "full"] });
    expect(withTiers).toContain("/api/overlay?detail=2&env=local&tier=light");
    expect(withTiers).toContain("/api/overlay?detail=2&env=local&tier=full");
  });
});

// The ops lens (#284): a static bundle must not offer a stop it never
// captured. The SPA gates the stop on /api/project's `ops`, and the capture
// gates the snapshot on the same number.
describe("the ops lens in a static bundle (#284)", () => {
  it("drops detail/radial from an ops key, like components and logical", () => {
    const k = canonicalKey("/api/graph", new URLSearchParams("ops=1&detail=3&radial=1&layout=1"));
    expect(k).toBe("/api/graph?ops=1");
  });

  it("captures the ops view exactly once, outside the env/tier matrix", () => {
    const keys = captureKeys({ environments: ["local", "prod"], tiers: ["light", "full"], ops: 4 });
    expect(keys.filter((k) => k.includes("ops=1"))).toEqual(["/api/graph?ops=1"]);
  });

  it("captures nothing for an estate that has emitted no Ops", () => {
    const keys = captureKeys({ environments: ["local"], tiers: [] });
    expect(keys.some((k) => k.includes("ops=1"))).toBe(false);
    expect(captureKeys({ environments: ["local"], tiers: [], ops: 0 }).some((k) => k.includes("ops=1"))).toBe(false);
  });

  it("captures SQL Yodeler's report and its Pipeline lane only when the project has them (#537)", () => {
    const none = captureKeys({ environments: ["prod"], tiers: [] });
    expect(none).not.toContain("/api/yodel-report");
    expect(none).not.toContain("/api/sql-yodeler/lifecycle");
    const keys = captureKeys({ environments: ["prod"], tiers: [], yodelReport: true, sqlYodeler: true });
    expect(keys).toContain("/api/yodel-report");
    expect(keys).toContain("/api/sql-yodeler/lifecycle");
    expect(keys).toContain("/api/lifecycle/history");
  });
});

describe("what a bundle is called (#827)", () => {
  const workspace = { name: "three-cloud", root: "/home/me/ws", file: "chant.workspace.json", chant: "0.124.32", members: [] };

  it("names a declared workspace after itself, not after its first member", () => {
    // serve's reading of a workspace puts its first drawn member in projectDir.
    const id = bundleIdentity({ projectDir: "/home/me/ws/dns", workspace });
    expect(id).toEqual({ projectDir: "ws", worker: "three-cloud", workspace: "three-cloud" });
    expect(workerName(id.worker)).toBe("behold-three-cloud");
  });

  it("names a single project after its directory, as before", () => {
    const id = bundleIdentity({ projectDir: "/home/me/my-project" });
    expect(id).toEqual({ projectDir: "my-project", worker: "my-project" });
    expect(workerName(id.worker)).toBe("behold-my-project");
  });

  it("takes --name over either, and keeps a Worker name lowercase alnum and hyphens", () => {
    expect(workerName("three-cloud", "Front Door")).toBe("front-door");
    expect(workerName("Three_Cloud")).toBe("behold-three-cloud");
  });
});

describe("the view a bundle opens on (#827)", () => {
  const axes = { environments: ["frozen", "prod"], tiers: [] };

  it("takes a captured env and a known zoom", () => {
    expect(settleOpening({ env: "frozen", zoom: "composites" }, axes)).toEqual({ opening: { env: "frozen", zoom: "composites" } });
    expect(settleOpening({}, axes)).toEqual({ opening: {} });
    for (const zoom of OPENING_ZOOMS) expect(settleOpening({ zoom }, axes)).toEqual({ opening: { zoom } });
  });

  it("refuses an env the export doesn't capture, naming the ones it does", () => {
    expect(settleOpening({ env: "staging" }, axes)).toEqual({ error: "--open-env staging isn't an environment this export captures: it captures frozen, prod" });
    expect(settleOpening({ env: "prod" }, { environments: [] })).toEqual({
      error: "--open-env prod isn't an environment this export captures: it captures no environment, only the source graph",
    });
  });

  it("refuses a zoom the bundle holds no snapshot for", () => {
    expect(settleOpening({ zoom: "galaxy" }, axes)).toEqual({ error: "--open-zoom galaxy isn't a zoom this export captures: it takes components, logical, composites, resources, attributes" });
    // runtime and the apply order have no snapshot of their own in a bundle.
    expect("error" in settleOpening({ zoom: "runtime" }, axes)).toBe(true);
    expect("error" in settleOpening({ zoom: "stacks" }, axes)).toBe(true);
  });

  it("takes ops only when the estate emitted Ops, as the capture does", () => {
    expect("error" in settleOpening({ zoom: "ops" }, axes)).toBe(true);
    expect(settleOpening({ zoom: "ops" }, { ...axes, ops: 2 })).toEqual({ opening: { zoom: "ops" } });
  });
});

describe("copyNotices — the export carries the grants it redistributes (#394)", () => {
  it("copies LICENSE, THIRD_PARTY.md and every file under licenses/ into the bundle", async () => {
    const { mkdtempSync, existsSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const out = mkdtempSync(join(tmpdir(), "behold-export-notices-"));
    const copied = copyNotices(out);
    expect(copied).toContain("LICENSE");
    expect(copied).toContain("THIRD_PARTY.md");
    expect(copied.filter((f) => f.startsWith("licenses/")).length).toBeGreaterThanOrEqual(3);
    expect(existsSync(join(out, "LICENSE"))).toBe(true);
    expect(readdirSync(join(out, "licenses")).length).toBe(copied.filter((f) => f.startsWith("licenses/")).length);
  });

  it("the package ships them too: LICENSE, THIRD_PARTY.md and licenses/ are in package.json files, and the grant is declared", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { license?: string; files: string[] };
    expect(pkg.license).toBe("Apache-2.0");
    for (const f of ["LICENSE", "THIRD_PARTY.md", "licenses"]) expect(pkg.files).toContain(f);
  });
});
