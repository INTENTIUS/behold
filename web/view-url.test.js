import { describe, expect, it } from "vitest";
import { readViewQuery, writeViewQuery, settleView, settlePlace, refusalLine, isEnvName, withOpening, defaultEnv, checkQuery, checkSnapshot, QUERY_MAX, viewFromObject, restoreViewQuery } from "./view-url.js";

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
  it("writes alike only when an estate draws every card, since stacked is the default (#877)", () => {
    expect(writeViewQuery("", { zoom: "resources", alike: true })).toBe("?zoom=resources");
    expect(writeViewQuery("", { zoom: "resources", alike: false })).toBe("?zoom=resources&alike=0");
    expect(writeViewQuery("", { zoom: "logical", alike: undefined })).toBe("?zoom=logical");
  });
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

describe("focus (#569)", () => {
  it("reads, writes and settles a list of box names", () => {
    expect(readViewQuery("?focus=app,edge")).toEqual({ focus: "app,edge" });
    expect(readViewQuery("?focus=")).toEqual({ focus: null });
    expect(writeViewQuery("?embed=1", { focus: "app,edge" })).toBe("?embed=1&focus=app%2Cedge");
    expect(settleView({ focus: " app , edge " }, {}).apply).toEqual({ focus: "app,edge" });
    expect(settleView({ focus: null }, {}).apply).toEqual({ focus: null });
  });
  it("refuses a focus that isn't box names", () => {
    expect(settleView({ focus: "app,<b>" }, {}).refused[0].key).toBe("focus");
  });
});

describe("run (#569)", () => {
  it("takes a commit, none or base, and null for the newest", () => {
    expect(readViewQuery("?run=abc1234")).toEqual({ run: "abc1234" });
    expect(settleView({ run: "base" }, {}).apply).toEqual({ run: "base" });
    expect(settleView({ run: null }, {}).apply).toEqual({ run: null });
    expect(settleView({ run: "main" }, {}).refused[0].key).toBe("run");
    expect(settleView({ run: "pull-989-659dee43" }, {}).apply).toEqual({ run: "pull-989-659dee43" });
    expect(settleView({ run: "pull-989" }, {}).apply).toEqual({ run: "pull-989" });
    expect(settleView({ run: "pull" }, {}).apply).toEqual({ run: "pull" });
    expect(settleView({ run: "pull-x" }, {}).refused[0].key).toBe("run");
    expect(writeViewQuery("", { run: "none" })).toBe("?run=none");
  });
});

describe("an export's opening view (#827)", () => {
  it("opens on the manifest's env and zoom when the link names neither", () => {
    expect(withOpening({ env: "frozen", zoom: "composites" }, readViewQuery(""))).toEqual({ env: "frozen", zoom: "composites" });
  });
  it("lets the link's own query win, key by key", () => {
    expect(withOpening({ env: "frozen", zoom: "composites" }, readViewQuery("?zoom=resources"))).toEqual({ env: "frozen", zoom: "resources" });
    // env= in a link is the source graph, and still wins over the opening env.
    expect(withOpening({ env: "frozen" }, readViewQuery("?env="))).toEqual({ env: null });
  });
  it("is nothing for a bundle that chose no view, or a live serve with no manifest", () => {
    expect(withOpening(undefined, readViewQuery("?member=dns"))).toEqual({ member: "dns" });
    expect(withOpening(null, {})).toEqual({});
    expect(withOpening({ env: 3, zoom: "", node: "x" }, {})).toEqual({});
  });
  it("makes the opening env the default a reload falls back to", () => {
    expect(defaultEnv({ env: "frozen" }, null)).toBe("frozen");
    expect(defaultEnv(undefined, "prod")).toBe("prod");
    expect(defaultEnv({ zoom: "composites" }, null)).toBe(null);
    // the source graph in such a bundle is written env=, so a reload keeps it
    expect(writeViewQuery("", { zoom: "composites", env: null }, { env: defaultEnv({ env: "frozen" }, null) })).toBe("?zoom=composites&env=");
  });
});

describe("q and snapshot (#913, #914)", () => {
  it("reads and writes q and snapshot through the URL, + for a space and %2B for a plus", () => {
    const q = "attr:internetFacing=true attr:effectiveIngress=tcp:22:0.0.0.0/0 a+b";
    const search = writeViewQuery("", { zoom: "resources", env: "prod", q, snapshot: "latest" });
    expect(search).toBe("?zoom=resources&env=prod&q=attr%3AinternetFacing%3Dtrue+attr%3AeffectiveIngress%3Dtcp%3A22%3A0.0.0.0%2F0+a%2Bb&snapshot=latest");
    expect(readViewQuery(search)).toEqual({ zoom: "resources", env: "prod", q, snapshot: "latest" });
    expect(readViewQuery("?q=")).toEqual({ q: null });
  });
  it("checkQuery passes chant's grammar through and refuses control characters, length and non-strings", () => {
    expect(checkQuery('  ->kind:Bucket !"x <-a  ')).toEqual({ ok: true, value: '->kind:Bucket !"x <-a' });
    expect(checkQuery("")).toEqual({ ok: true, value: null });
    expect(checkQuery(null)).toEqual({ ok: true, value: null });
    expect(checkQuery("a\tb").ok).toBe(false);
    expect(checkQuery("a\u007fb").ok).toBe(false);
    expect(checkQuery("x".repeat(QUERY_MAX)).ok).toBe(true);
    expect(checkQuery("x".repeat(QUERY_MAX + 1)).ok).toBe(false);
    expect(checkQuery(3).ok).toBe(false);
  });
  it("settleView takes q, and a snapshot only on an env", () => {
    expect(settleView({ q: "kind:Bucket" }, {})).toEqual({ apply: { q: "kind:Bucket" }, refused: [] });
    expect(settleView({ q: "a\nb" }, {}).refused[0].key).toBe("q");
    expect(settleView({ snapshot: "latest", env: "prod" }, { envs: ["prod"] }).apply).toEqual({ env: "prod", snapshot: "latest" });
    expect(settleView({ snapshot: "latest" }, { env: "prod" }).apply).toEqual({ snapshot: "latest" });
    expect(settleView({ snapshot: "latest" }, {}).refused[0]).toMatchObject({ key: "snapshot", reason: "a snapshot is of an env; name one with env" });
    expect(settleView({ snapshot: "a b" }, { env: "prod" }).refused[0].key).toBe("snapshot");
    expect(settleView({ snapshot: null }, {}).apply).toEqual({ snapshot: null });
    expect(checkSnapshot("latest")).toEqual({ ok: true, value: "latest" });
  });
});

describe("viewFromObject (#914)", () => {
  it("takes the view keys and names everything else", () => {
    const { want, refused } = viewFromObject({ q: "x", env: "", member: null, radial: true, zoom: "resources", at: "abc", other: 1, focus: 3 });
    expect(want).toEqual({ q: "x", env: null, member: null, radial: true, zoom: "resources" });
    expect(refused.map((r) => r.key)).toEqual(["at", "other", "focus"]);
    expect(refused[0].reason).toMatch(/git revision/);
  });
  it("refuses a view that isn't an object", () => {
    expect(viewFromObject("q=x").refused[0].key).toBe("view");
    expect(viewFromObject(null).want).toEqual({});
  });
});

describe("restoreViewQuery (#914)", () => {
  it("clears what the URL leaves out, so Back undoes a move", () => {
    expect(restoreViewQuery("?zoom=resources", { env: "prod", lens: "cost" })).toEqual({
      zoom: "resources",
      member: null,
      gates: null,
      focus: null,
      run: null,
      pull: null,
      q: null,
      snapshot: null,
      radial: false,
      alike: true,
      env: "prod",
      lens: "cost",
    });
    expect(restoreViewQuery("?zoom=logical&env=&q=kind%3AX").env).toBe(null);
    expect(restoreViewQuery("?zoom=logical&env=&q=kind%3AX").q).toBe("kind:X");
  });
});
