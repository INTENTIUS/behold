import { describe, expect, it } from "vitest";
import { allowedHostsFrom, guardRequest, hostName } from "./request-guard.ts";

const cfg = { allowedHosts: [] as string[] };

describe("guardRequest", () => {
  it("answers loopback names, with or without a port", () => {
    for (const host of ["localhost:4600", "127.0.0.1:4600", "[::1]:4600", "localhost", "b-7.localhost:9"]) {
      expect(guardRequest({ method: "GET", host }, cfg)).toEqual({ ok: true });
    }
  });
  it("refuses a Host that isn't loopback or allowed (DNS rebinding)", () => {
    const v = guardRequest({ method: "GET", host: "evil.example:4600" }, cfg);
    expect(v).toMatchObject({ ok: false, status: 421 });
    expect(guardRequest({ method: "GET", host: "site-7.arugula.test" }, { allowedHosts: ["site-7.arugula.test"] })).toEqual({ ok: true });
  });
  it("takes the address it was bound to, but not a wildcard", () => {
    expect(guardRequest({ method: "GET", host: "10.0.0.5:4600" }, { allowedHosts: [], boundHost: "10.0.0.5" })).toEqual({ ok: true });
    expect(guardRequest({ method: "GET", host: "10.0.0.5:4600" }, { allowedHosts: [], boundHost: "0.0.0.0" }).ok).toBe(false);
  });
  it("refuses a cross-site write, and a write from another origin", () => {
    expect(guardRequest({ method: "POST", host: "localhost:4600", secFetchSite: "cross-site" }, cfg)).toMatchObject({ ok: false, status: 403 });
    expect(guardRequest({ method: "POST", host: "localhost:4600", origin: "https://evil.example" }, cfg)).toMatchObject({ ok: false, status: 403 });
    expect(guardRequest({ method: "POST", host: "localhost:4600", origin: "http://localhost:3000" }, cfg)).toMatchObject({ ok: false, status: 403 });
    expect(guardRequest({ method: "POST", host: "localhost:4600", origin: "null" }, cfg)).toMatchObject({ ok: false, status: 403 });
  });
  it("lets behold's own page write, a request with no Origin (curl), and an allowed proxy's page", () => {
    expect(guardRequest({ method: "POST", host: "localhost:4600", origin: "http://localhost:4600", secFetchSite: "same-origin" }, cfg)).toEqual({ ok: true });
    expect(guardRequest({ method: "POST", host: "127.0.0.1:4600" }, cfg)).toEqual({ ok: true });
    expect(guardRequest({ method: "POST", host: "localhost:4600", origin: "https://site-7.arugula.test" }, { allowedHosts: ["site-7.arugula.test"] })).toEqual({ ok: true });
  });
  it("reads names and lists", () => {
    expect(hostName("LOCALHOST:80")).toBe("localhost");
    expect(hostName("[::1]:80")).toBe("[::1]");
    expect(allowedHostsFrom(["a", " b "], "c,,d")).toEqual(["a", "b", "c", "d"]);
  });
});
