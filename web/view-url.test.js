import { describe, expect, it } from "vitest";
import { readViewQuery, writeViewQuery, settleView, settlePlace, refusalLine, isEnvName } from "./view-url.js";

describe("readViewQuery (#475)", () => {
  it("reads the view keys and nothing else", () => {
    expect(readViewQuery("?member=delivery&zoom=components&env=prod&node=delivery/appService&embed=1")).toEqual({
      member: "delivery",
      zoom: "components",
      env: "prod",
      node: "delivery/appService",
    });
  });
  it("reads radial as a boolean, and an empty env as the source graph", () => {
    expect(readViewQuery("?radial=1&env=")).toEqual({ radial: true, env: null });
    expect(readViewQuery("?radial=0")).toEqual({ radial: false });
  });
  it("drops empty values", () => {
    expect(readViewQuery("?member=&zoom=")).toEqual({});
  });
});

describe("writeViewQuery (#475)", () => {
  it("keeps parameters that are not the view's, and leaves defaults out", () => {
    const q = writeViewQuery("?embed=1&host=http%3A%2F%2Fa&member=old", { member: "delivery", zoom: "resources", env: null, lens: "drift", radial: false, node: null });
    expect(q).toBe("?embed=1&host=http%3A%2F%2Fa&member=delivery&zoom=resources");
  });
  it("round-trips through readViewQuery", () => {
    const state = { member: "delivery", zoom: "components", env: "prod", tier: "local", lens: "cost", node: "delivery/appService", radial: true };
    expect(readViewQuery(writeViewQuery("", state))).toEqual(state);
  });
  it("writes env= for the source graph when behold was started on an env, so a reload doesn't open live", () => {
    expect(writeViewQuery("", { zoom: "resources", env: null }, { env: "prod" })).toBe("?zoom=resources&env=");
    expect(readViewQuery("?zoom=resources&env=")).toEqual({ zoom: "resources", env: null });
  });
  it("writes a lens that differs from the saved one, drift included", () => {
    expect(writeViewQuery("", { lens: "drift" }, { lens: "cost" })).toBe("?lens=drift");
    expect(writeViewQuery("", { lens: "cost" }, { lens: "cost" })).toBe("");
  });
  it("writes nothing for an empty view", () => {
    expect(writeViewQuery("", {})).toBe("");
  });
});

describe("settleView (#475)", () => {
  const offer = { zooms: ["components", "resources"], envs: ["prod"], tiers: [], lenses: ["drift", "cost", "headroom"] };
  it("applies what the estate offers", () => {
    expect(settleView({ zoom: "resources", env: "prod", lens: "cost", radial: true, member: "m" }, offer)).toEqual({
      apply: { zoom: "resources", env: "prod", lens: "cost", radial: true, member: "m" },
      refused: [],
    });
  });
  it("names what it can't honour, with the reason", () => {
    const { apply, refused } = settleView({ zoom: "ops", env: "staging", tier: "aws", radial: "maybe" }, offer);
    expect(apply).toEqual({});
    expect(refused.map((r) => r.key)).toEqual(["zoom", "env", "tier", "radial"]);
    expect(refused[1].reason).toBe("this estate declares prod");
    expect(refused[2].reason).toBe("this project offers no tiers");
  });
  it("takes env= as the source graph", () => {
    expect(settleView({ env: null }, offer).apply).toEqual({ env: null });
  });
});

describe("gates, the gate strip's env (#477)", () => {
  it("reads gates from the query, and an empty one as no override", () => {
    expect(readViewQuery("?gates=prod&env=")).toEqual({ env: null, gates: "prod" });
    expect(readViewQuery("?gates=")).toEqual({});
  });
  it("owns gates on write-back: written when set, dropped when cleared", () => {
    expect(writeViewQuery("?embed=1&gates=old", { zoom: "resources", gates: "prod" })).toBe("?embed=1&zoom=resources&gates=prod");
    expect(writeViewQuery("?embed=1&gates=old", { zoom: "resources", gates: null })).toBe("?embed=1&zoom=resources");
  });
  it("round-trips through readViewQuery", () => {
    expect(readViewQuery(writeViewQuery("", { gates: "staging" }))).toEqual({ gates: "staging" });
  });
  it("takes an env name or null, and refuses anything chant would read as a flag", () => {
    expect(settleView({ gates: "prod" }, {}).apply).toEqual({ gates: "prod" });
    expect(settleView({ gates: null }, {}).apply).toEqual({ gates: null });
    const { apply, refused } = settleView({ gates: "--sign" }, {});
    expect(apply).toEqual({});
    expect(refused).toEqual([{ key: "gates", value: "--sign", reason: "an env name is letters, digits, '.', '_' and '-'" }]);
  });
  it("matches the server's env-name check", () => {
    for (const ok of ["local", "prod-eu", "a.b_c", "0"]) expect(isEnvName(ok)).toBe(true);
    for (const bad of ["", "-x", ".x", "a b", "a/b", null]) expect(isEnvName(bad)).toBe(false);
  });
});

describe("settlePlace (#475)", () => {
  const members = new Set(["delivery", "app"]);
  const nodes = new Set(["delivery/appService", "app/x"]);
  it("opens a member and a node in it", () => {
    expect(settlePlace({ member: "delivery", node: "delivery/appService" }, members, nodes)).toEqual({
      apply: { member: "delivery", node: "delivery/appService" },
      refused: [],
    });
  });
  it("refuses an unknown member, an absent node, and a node in another member", () => {
    expect(settlePlace({ member: "nope" }, members, nodes).refused[0].reason).toBe("the members here are delivery, app");
    expect(settlePlace({ node: "delivery/gone" }, members, nodes).refused[0].key).toBe("node");
    expect(settlePlace({ member: "delivery", node: "app/x" }, members, nodes).refused[0].reason).toBe("it isn't in member delivery");
  });
  it("says it in one line", () => {
    expect(refusalLine([{ key: "zoom", value: "ops", reason: "this estate offers components" }])).toBe(
      "from the link: zoom=ops not opened, this estate offers components",
    );
    expect(refusalLine([])).toBe("");
  });
});
