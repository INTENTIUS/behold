// #268: what the switcher's demo buttons say. Pure functions over one /api/demos
// row, so they get unit tests next to them; the smoke covers the DOM they end up
// in. The two rules worth pinning: a demo that can't run here says WHY (it is
// rendered disabled, not dropped), and one that would clone from the network
// says so on the button, before anyone clicks it.
import { describe, it, expect } from "vitest";
import { fetchDemos, shortRepo, demoNote, demoLabel, demoTitle, demoProgress } from "./demos.js";

const row = (over = {}) => ({
  name: "k8s",
  description: "nginx on a throwaway k3d cluster.",
  requires: ["docker", "k3d"],
  source: "bundled",
  fetches: false,
  target: "/w/behold-demos/k8s",
  loaded: false,
  satisfiable: true,
  ...over,
});

describe("the demo button's face", () => {
  it("a runnable, unloaded demo is just its name", () => {
    expect(demoLabel(row())).toBe("k8s");
    expect(demoNote(row())).toBe("");
  });

  it("an unsatisfiable demo carries its reason — the disabled row still teaches", () => {
    const blocked = row({ satisfiable: false, reason: "needs k3d on PATH" });
    expect(demoLabel(blocked)).toBe("k8s · needs k3d on PATH");
    expect(demoTitle(blocked)).toContain("Can't run here — needs k3d on PATH");
    // A server that forgot the reason still says something honest.
    expect(demoNote(row({ satisfiable: false }))).toBe("unavailable here");
  });

  it("a network-fetching demo names the repo it would clone", () => {
    const remote = row({ name: "fountain", fetches: true, repo: "https://github.com/INTENTIUS/fountain-ops" });
    expect(demoLabel(remote)).toBe("fountain · clones github.com/INTENTIUS/fountain-ops");
    expect(demoTitle(remote)).toContain("Clones https://github.com/INTENTIUS/fountain-ops");
    expect(demoProgress(remote)).toContain("cloning");
    expect(demoProgress(row())).toContain("copying");
    // The reason wins over the fetch note: it can't run at all.
    expect(demoNote(row({ fetches: true, satisfiable: false, reason: "needs git on PATH" }))).toBe("needs git on PATH");
  });

  it("an already-copied demo says so, and its tooltip promises a reuse", () => {
    expect(demoLabel(row({ loaded: true }))).toBe("k8s · loaded");
    expect(demoTitle(row({ loaded: true }))).toContain("Reuses /w/behold-demos/k8s");
    expect(demoTitle(row())).toContain("Copies the bundled example to /w/behold-demos/k8s");
  });

  it("shortRepo drops the scheme and the .git suffix", () => {
    expect(shortRepo("https://github.com/INTENTIUS/fountain-ops.git")).toBe("github.com/INTENTIUS/fountain-ops");
    expect(shortRepo(undefined)).toBe("");
  });
});

describe("fetchDemos degrades to an empty catalog", () => {
  const res = (body, ok = true) => ({ ok, json: async () => body });

  it("returns the rows a server answers with", async () => {
    expect(await fetchDemos(async () => res({ demos: [row()] }))).toHaveLength(1);
  });

  it("a 404 (an older server), a junk body, or a dead fetch is no group at all", async () => {
    expect(await fetchDemos(async () => res({}, false))).toEqual([]);
    expect(await fetchDemos(async () => res({ demos: "nope" }))).toEqual([]);
    expect(
      await fetchDemos(async () => {
        throw new Error("offline");
      }),
    ).toEqual([]);
  });
});
