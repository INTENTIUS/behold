import { describe, expect, it } from "vitest";
import { ROOT_HUES, cssString, hoverCss, hoverFromMessage, hoverLinks, hoverMessage, isLightBg, rootColour, rootOrder, rootSegments, rootsOfWave, waveOfJob } from "./kiosk-roots.js";

// behold#571: the demo repo's roots and the wave jobs of its terragucci.components.json.
const ROOTS = ["network", "other", "app", "edge"];
const WAVES = [
  { job: "apply-wave-1", wave: 1, roots: ["network", "other"] },
  { job: "apply-wave-2", wave: 2, roots: ["app"] },
  { job: "apply-wave-3", wave: 3, roots: ["edge"] },
];
const names = (text) => rootSegments(text, ROOTS).filter((s) => s.root).map((s) => s.root);

describe("a colour per root (behold#571)", () => {
  it("follows the sorted root list, so it is the same on every cycle and in any order", () => {
    expect(rootOrder(ROOTS)).toEqual(["app", "edge", "network", "other"]);
    const a = Object.fromEntries(ROOTS.map((r) => [r, rootColour(r, ROOTS)]));
    const b = Object.fromEntries(ROOTS.map((r) => [r, rootColour(r, [...ROOTS].reverse())]));
    expect(a).toEqual(b);
    expect(a.app).toBe(ROOT_HUES.dark[0]);
    expect(new Set(Object.values(a)).size).toBe(4);
    expect(rootColour("app", ROOTS, { light: true })).toBe(ROOT_HUES.light[0]);
    expect(rootColour("nope", ROOTS)).toBeNull();
  });

  it("uses no state colour: not the green, amber, red, blue or teal of the theme", () => {
    const state = ["#a6e3a1", "#f9e2af", "#f38ba8", "#89b4fa", "#94e2d5", "#6d7187"];
    for (const hue of [...ROOT_HUES.dark, ...ROOT_HUES.light]) expect(state).not.toContain(hue.toLowerCase());
    expect(new Set(ROOT_HUES.dark).size).toBe(ROOT_HUES.dark.length);
    expect(new Set(ROOT_HUES.light).size).toBe(ROOT_HUES.light.length);
  });

  it("tells a light background from a dark one", () => {
    expect(isLightBg("#ffffff")).toBe(true);
    expect(isLightBg(" #1e1e2e")).toBe(false);
    expect(isLightBg("")).toBe(false);
  });
});

describe("root names in a line (behold#571)", () => {
  it("finds whole-word names, possessives and names in brackets, and keeps the line's text", () => {
    const line = "app reads subnet_id from network, set when network applies.";
    expect(names(line)).toEqual(["app", "network", "network"]);
    expect(rootSegments(line, ROOTS).map((s) => s.text).join("")).toBe(line);
    expect(names("approves wave 2 (app) with network's key")).toEqual(["app", "network"]);
    expect(names("app: Plan: 0 to add, 1 to change, 0 to destroy.")).toEqual(["app"]);
  });

  it("leaves names inside addresses, hosts, URLs, paths, hashes and longer words alone", () => {
    expect(names("terraform_data.app_x and data.terraform_remote_state.network")).toEqual([]);
    expect(names("upstream http://app:9080 and app:8070")).toEqual([]);
    expect(names("report copied to demo/forgejo:3000/terragucci-admin/demo/2026/10/ef95/tf-apply-wave-1")).toEqual([]);
    expect(names("set digest jcs1-sha256:0accc105ba06 and commit a1b2c3d4e5")).toEqual([]);
    expect(names("apply-wave-2 appliance networks edge-proxy network.tfstate")).toEqual([]);
    expect(names("key=network")).toEqual([]);
  });

  it("says nothing without roots", () => {
    expect(rootSegments("network", [])).toEqual([{ text: "network" }]);
    expect(rootSegments("", ROOTS)).toEqual([]);
  });
});

describe("hover links between the panes (behold#571)", () => {
  it("ties a wave's job to its roots, from the declared jobs or the job's name", () => {
    expect(waveOfJob("apply-wave-2", WAVES)).toBe(2);
    expect(waveOfJob("apply-wave-7", [])).toBe(7);
    expect(waveOfJob("check", WAVES)).toBeNull();
    expect(rootsOfWave(1, WAVES)).toEqual(["network", "other"]);
    expect(rootsOfWave(9, WAVES)).toEqual([]);
  });

  it("lights a root's mentions and its wave, and a wave's job and its roots", () => {
    expect(hoverLinks({ root: "other" }, WAVES)).toEqual({ roots: ["other"], waves: [1] });
    expect(hoverLinks({ wave: 1 }, WAVES)).toEqual({ roots: ["network", "other"], waves: [1] });
    expect(hoverLinks({ root: "lonely" }, WAVES)).toEqual({ roots: ["lonely"], waves: [] });
    expect(hoverLinks(null, WAVES)).toEqual({ roots: [], waves: [] });
  });

  it("carries a hover between the frame and the kiosk as a message, and takes only that message", () => {
    expect(hoverMessage({ root: "app" })).toEqual({ type: "behold:hover", root: "app", wave: null });
    expect(hoverMessage(null)).toEqual({ type: "behold:hover", root: null, wave: null });
    expect(hoverFromMessage(hoverMessage({ wave: 2 }))).toEqual({ wave: 2 });
    expect(hoverFromMessage(hoverMessage({ root: "app" }))).toEqual({ root: "app" });
    expect(hoverFromMessage(hoverMessage(null))).toBeNull();
    expect(hoverFromMessage({ type: "behold:view" })).toBeUndefined();
    expect(hoverFromMessage("behold:hover")).toBeUndefined();
  });

  it("writes one rule for what a hover lights, quoting names", () => {
    const css = hoverCss(hoverLinks({ wave: 2 }, WAVES), { root: (r) => `.k-root[data-k-root=${cssString(r)}]`, wave: (w) => `.r-job[data-k-wave="${w}"]` }, "outline: 1px solid");
    expect(css).toBe('.k-root[data-k-root="app"],\n.r-job[data-k-wave="2"] { outline: 1px solid }');
    expect(hoverCss({ roots: [], waves: [] }, { root: () => "x", wave: () => "y" }, "z")).toBe("");
    expect(cssString('a"b')).toBe('"a\\"b"');
  });
});
