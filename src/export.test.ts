import { describe, it, expect } from "vitest";
import { canonicalKey, captureKeys } from "./export.ts";

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

  it("drops detail/radial for the components view (the frontend appends them, the DAG ignores them)", () => {
    // load() always sends the current detail even in the components view.
    const k = canonicalKey("/api/graph", new URLSearchParams("components=1&detail=3&env=local&radial=1"));
    expect(k).toBe("/api/graph?components=1&env=local");
  });

  it("drops detail/radial for the network view too (re-projected at detail 3, dial ignored)", () => {
    const k = canonicalKey("/api/overlay", new URLSearchParams("network=1&detail=3&env=local&radial=1"));
    expect(k).toBe("/api/overlay?env=local&network=1");
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

  it("captures the network lens — source graph for no-env, overlay per env (#63)", () => {
    expect(keys).toContain("/api/graph?network=1"); // source (no env)
    expect(keys).toContain("/api/overlay?env=local&network=1");
    expect(keys).toContain("/api/overlay?env=prod&network=1");
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
