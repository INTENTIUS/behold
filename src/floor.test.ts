import { describe, expect, it } from "vitest";
import { meetsFloor } from "./floor.ts";

// `meetsFloor` decides whether behold refuses a project's chant, and seven
// modules read it: src/chant.ts re-exports it, and the doctor line, the
// carve-status reader, the operator-log route and the terraform reader all gate
// on it. It had no test. Nothing here is a bug fix — every case below already
// passed when it was written. They are pinned because a silent regression here
// either refuses a chant that is fine or accepts one that is not, and neither
// failure announces itself.
describe("meetsFloor", () => {
  it("compares the dotted numbers", () => {
    expect(meetsFloor("0.61.0", "0.61.0")).toBe(true);
    expect(meetsFloor("0.62.0", "0.61.0")).toBe(true);
    expect(meetsFloor("0.60.0", "0.61.0")).toBe(false);
    expect(meetsFloor("1.0.0", "0.61.0")).toBe(true);
  });

  it("compares numerically, not lexically", () => {
    // The case a string compare gets wrong: "0.9.0" > "0.10.0" as text.
    expect(meetsFloor("0.9.0", "0.10.0")).toBe(false);
    expect(meetsFloor("0.10.0", "0.9.0")).toBe(true);
  });

  it("ignores a leading v", () => {
    expect(meetsFloor("v0.61.0", "0.61.0")).toBe(true);
    expect(meetsFloor("v0.60.0", "0.61.0")).toBe(false);
  });

  it("drops the prerelease suffix, so an rc of the floor is close enough", () => {
    // The module's own rule: an rc of the floor is not worth warning about.
    expect(meetsFloor("0.44.3-rc.1", "0.44.3")).toBe(true);
    // And a git-describe build, which is how a choudoufu built from main reads.
    expect(meetsFloor("v0.15.0-30-g9c7d3701e2", "0.15.0")).toBe(true);
  });

  it("treats a missing segment as zero", () => {
    expect(meetsFloor("0.61", "0.61.0")).toBe(true);
    expect(meetsFloor("0.61.0", "0.61")).toBe(true);
    expect(meetsFloor("0.60", "0.61.0")).toBe(false);
  });

  it("fails OPEN on anything it cannot read", () => {
    // Deliberate, and the reason is in the module: an unknown version is not
    // evidence of an old one. Refusing on an unparseable version would break
    // every project whose chant reports something unexpected.
    expect(meetsFloor("garbage", "0.61.0")).toBe(true);
    expect(meetsFloor("0.61.0", "garbage")).toBe(true);
    expect(meetsFloor(undefined, "0.61.0")).toBe(true);
    expect(meetsFloor("0.61.0", undefined)).toBe(true);
    expect(meetsFloor(undefined, undefined)).toBe(true);
  });
});
