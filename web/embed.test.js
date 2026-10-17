import { describe, expect, it } from "vitest";
import { kioskQuietLine, readEmbed, selectMessage, viewFromMessage, THEME_ALIASES, wheelPx, wheelZoomsBare } from "./embed.js";

describe("readEmbed (#476)", () => {
  it("reads embed, an exact host origin and a theme", () => {
    expect(readEmbed("?embed=1&host=http%3A%2F%2Flocalhost%3A7777%2Fsome%2Fpath&theme=dark")).toEqual({
      embed: true,
      host: "http://localhost:7777",
      theme: THEME_ALIASES.dark,
      bare: false,
    });
  });
  it("reads bare only inside embed (#569)", () => {
    expect(readEmbed("?embed=1&bare=1").bare).toBe(true);
    expect(readEmbed("?bare=1").bare).toBe(false);
  });
  it("takes no host that isn't an http(s) origin", () => {
    expect(readEmbed("?host=localhost").host).toBe(null);
    expect(readEmbed("?host=javascript%3Aalert(1)").host).toBe(null);
  });
  it("passes a theme name through", () => {
    expect(readEmbed("?theme=Atom%20One%20Light").theme).toBe("Atom One Light");
  });
  it("is off by default", () => {
    expect(readEmbed("")).toEqual({ embed: false, host: null, theme: null, bare: false });
  });
});

describe("selectMessage (#476)", () => {
  it("names the member and the card", () => {
    expect(selectMessage("delivery", "delivery/appService")).toEqual({ type: "behold:select", member: "delivery", node: "delivery/appService" });
    expect(selectMessage("delivery", null)).toEqual({ type: "behold:select", member: "delivery", node: null });
  });
});

describe("viewFromMessage (#476)", () => {
  const host = "http://localhost:7777";
  it("takes the view keys from the host", () => {
    const e = { origin: host, data: { type: "behold:view", member: "delivery", env: "prod", radial: true, embed: "ignored", zoom: 3 } };
    expect(viewFromMessage(e, host)).toEqual({ member: "delivery", env: "prod", radial: true });
  });
  it("reads member null as the whole estate and env empty as the source", () => {
    expect(viewFromMessage({ origin: host, data: { type: "behold:view", member: null, env: "" } }, host)).toEqual({ member: null, env: null });
  });
  it("takes gates, the gate strip's env, and null or empty as following the graph's env (#477)", () => {
    expect(viewFromMessage({ origin: host, data: { type: "behold:view", gates: "prod" } }, host)).toEqual({ gates: "prod" });
    expect(viewFromMessage({ origin: host, data: { type: "behold:view", gates: "" } }, host)).toEqual({ gates: null });
    expect(viewFromMessage({ origin: host, data: { type: "behold:view", gates: null } }, host)).toEqual({ gates: null });
    expect(viewFromMessage({ origin: host, data: { type: "behold:view", gates: 3 } }, host)).toEqual({});
  });
  it("ignores another origin, another type, and any message when there is no host", () => {
    expect(viewFromMessage({ origin: "http://evil", data: { type: "behold:view", member: "x" } }, host)).toBe(null);
    expect(viewFromMessage({ origin: host, data: { type: "other" } }, host)).toBe(null);
    expect(viewFromMessage({ origin: host, data: { type: "behold:view" } }, null)).toBe(null);
  });
});

describe("viewFromMessage focus (#569)", () => {
  const host = "http://localhost:7777";
  it("takes focus as box names, and null or empty as nothing brought forward", () => {
    expect(viewFromMessage({ origin: host, data: { type: "behold:view", focus: "network,other" } }, host)).toEqual({ focus: "network,other" });
    expect(viewFromMessage({ origin: host, data: { type: "behold:view", focus: null } }, host)).toEqual({ focus: null });
    expect(viewFromMessage({ origin: host, data: { type: "behold:view", focus: "" } }, host)).toEqual({ focus: null });
  });
});

describe("kioskQuietLine (behold#571)", () => {
  it("leaves out a card's kind and meta lines in the kiosk's frame", () => {
    for (const t of ["Component · chant", "terraform_data · terraform", "archetype: infra", "wave: 2", " root: app "]) expect(kioskQuietLine(t)).toBe(true);
  });
  it("keeps the names, the states and the reads", () => {
    for (const t of ["network", "terraform_data.http_proxy_port", "waiting", "reads network · planned · 1 unknown", "wave 2 · planned", "", null]) expect(kioskQuietLine(t)).toBe(false);
  });
});

describe("the wheel in the kiosk's bare frame", () => {
  it("zooms on a plain mouse wheel there, and only there", () => {
    expect(wheelZoomsBare(true, { deltaY: 100 })).toBe(true);
    expect(wheelZoomsBare(true, { deltaY: -3 })).toBe(true);
    expect(wheelZoomsBare(false, { deltaY: 100 })).toBe(false);
  });
  it("leaves a sideways-only scroll to the page", () => {
    expect(wheelZoomsBare(true, { deltaX: 40, deltaY: 0 })).toBe(false);
    expect(wheelZoomsBare(true, null)).toBe(false);
  });
  it("reads the delta in px whatever its unit", () => {
    expect(wheelPx({ deltaY: 100, deltaMode: 0 })).toBe(100);
    expect(wheelPx({ deltaY: 3, deltaMode: 1 })).toBe(48);
    expect(wheelPx({ deltaY: 1, deltaMode: 2 })).toBe(800);
    expect(wheelPx({})).toBe(0);
  });
});
