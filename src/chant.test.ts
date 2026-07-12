import { describe, it, expect } from "vitest";
import { graphFlags } from "./chant.ts";
import { overlayStatus } from "./overlay.ts";

describe("graphFlags", () => {
  it("is empty for no options", () => {
    expect(graphFlags({})).toEqual([]);
  });

  it("maps detail, lens, direction, env", () => {
    expect(graphFlags({ detail: 1, lens: "blast:vpc", down: true, env: "prod" })).toEqual([
      "--detail",
      "1",
      "--lens",
      "blast:vpc",
      "--down",
      "--env",
      "prod",
    ]);
  });

  it("adds live/overlay when set", () => {
    expect(graphFlags({ live: true, overlay: true, env: "prod" })).toEqual([
      "--env",
      "prod",
      "--live",
      "--overlay",
    ]);
  });
});

describe("overlayStatus", () => {
  it("maps chant _status tags to drift semantics", () => {
    expect(overlayStatus({ attrs: { _status: "good" } })).toBe("managed");
    expect(overlayStatus({ attrs: { _status: "warn" } })).toBe("foreign");
    expect(overlayStatus({ attrs: { _status: "accent" } })).toBe("pending");
    expect(overlayStatus({ attrs: {} })).toBeUndefined();
  });
});
