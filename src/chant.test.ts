import { describe, it, expect } from "vitest";
import { graphFlags, graphArgs, componentStatusArgs } from "./chant.ts";
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

describe("graphArgs", () => {
  it("builds the base view-format command for the entity graph", () => {
    expect(graphArgs("proj/src", "ir", {}, false)).toEqual(["graph", "proj/src", "--format", "ir"]);
  });

  it("inserts --components ahead of --format for the component-DAG projection (M1.0)", () => {
    expect(graphArgs("proj/src", "ir", {}, true)).toEqual(["graph", "proj/src", "--components", "--format", "ir"]);
  });

  it("still appends graphFlags after --format for either projection", () => {
    expect(graphArgs("proj/src", "layout", { env: "local" }, true)).toEqual([
      "graph",
      "proj/src",
      "--components",
      "--format",
      "layout",
      "--env",
      "local",
    ]);
    expect(graphArgs("proj/src", "layout", { env: "local" }, false)).toEqual([
      "graph",
      "proj/src",
      "--format",
      "layout",
      "--env",
      "local",
    ]);
  });
});

describe("componentStatusArgs", () => {
  it("builds `components status <env> --live --json` (M1.1 spike Q2)", () => {
    expect(componentStatusArgs("local")).toEqual(["components", "status", "local", "--live", "--json"]);
  });

  it("threads the env through verbatim", () => {
    expect(componentStatusArgs("prod")).toEqual(["components", "status", "prod", "--live", "--json"]);
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
