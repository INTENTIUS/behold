import { describe, expect, it } from "vitest";
import { readEmbed, selectMessage, viewFromMessage, THEME_ALIASES } from "./embed.js";

describe("readEmbed (#476)", () => {
  it("reads embed, an exact host origin and a theme", () => {
    expect(readEmbed("?embed=1&host=http%3A%2F%2Flocalhost%3A7777%2Fsome%2Fpath&theme=dark")).toEqual({
      embed: true,
      host: "http://localhost:7777",
      theme: THEME_ALIASES.dark,
    });
  });
  it("takes no host that isn't an http(s) origin", () => {
    expect(readEmbed("?host=localhost").host).toBe(null);
    expect(readEmbed("?host=javascript%3Aalert(1)").host).toBe(null);
  });
  it("passes a theme name through", () => {
    expect(readEmbed("?theme=Atom%20One%20Light").theme).toBe("Atom One Light");
  });
  it("is off by default", () => {
    expect(readEmbed("")).toEqual({ embed: false, host: null, theme: null });
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
  it("ignores another origin, another type, and any message when there is no host", () => {
    expect(viewFromMessage({ origin: "http://evil", data: { type: "behold:view", member: "x" } }, host)).toBe(null);
    expect(viewFromMessage({ origin: host, data: { type: "other" } }, host)).toBe(null);
    expect(viewFromMessage({ origin: host, data: { type: "behold:view" } }, null)).toBe(null);
  });
});
