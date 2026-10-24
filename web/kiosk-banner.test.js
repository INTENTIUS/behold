import { describe, expect, it } from "vitest";
import { CODE_BASE, PRODUCTS, bannerModel } from "./kiosk-banner.js";
import { VENDORS } from "./kiosk-vendor.js";

const ALL = ["choudoufu-compose", "terragrunt-choudoufu", "atmos-choudoufu"];

describe("the demo banner model", () => {
  it("names the example in plain words, with the tool's variant", () => {
    expect(bannerModel("choudoufu-compose").name).toBe("One plan, one apply, across estates");
    expect(bannerModel("terragrunt-choudoufu").name).toBe("One plan, one apply, across estates, with Terragrunt");
    expect(bannerModel("atmos-choudoufu").name).toBe("One plan, one apply, across estates, with Atmos");
  });
  it("links the public example tree", () => {
    expect(bannerModel("choudoufu-compose").code.url).toBe("https://github.com/INTENTIUS/terragucci/tree/main/example-demo-choudoufu-compose");
    expect(bannerModel("atmos-choudoufu").code.url).toBe(`${CODE_BASE}example-demo-atmos-choudoufu`);
    expect(bannerModel("terragrunt-choudoufu").code.url).toBe(`${CODE_BASE}example-demo-terragrunt-choudoufu`);
  });
  it("names the demo's own products: terragucci and choudoufu with logos, Terragrunt and Atmos as text, never OpenTofu", () => {
    expect(PRODUCTS.choudoufu.logo.src).toBe("/vendors/choudoufu.svg");
    expect(PRODUCTS.terragucci.logo.src).toBe("/vendors/terragucci.svg");
    for (const k of ["opentofu", "terragrunt", "atmos"]) expect(PRODUCTS[k].logo).toBeNull();
    expect(bannerModel("choudoufu-compose").products.map((p) => p.name)).toEqual(["terragucci", "choudoufu"]);
    expect(bannerModel("terragrunt-choudoufu").products.map((p) => p.name)).toEqual(["Terragrunt", "choudoufu"]);
    expect(bannerModel("atmos-choudoufu").products.map((p) => p.name)).toEqual(["Atmos", "choudoufu"]);
  });
  it("has the switcher only when more than one demo is listed", () => {
    expect(bannerModel("choudoufu-compose", ["choudoufu-compose"]).switcher).toEqual([]);
    const sw = bannerModel("atmos-choudoufu", ALL).switcher;
    expect(sw.map((x) => [x.path, x.current])).toEqual([["/choudoufu-compose", false], ["/terragrunt-choudoufu", false], ["/atmos-choudoufu", true]]);
  });
  it("is none for a page that is no listed demo", () => {
    expect(bannerModel("terraform")).toBeNull();
    expect(bannerModel(null)).toBeNull();
  });
  it("never names another commercial product, nor says atomic or transaction", () => {
    for (const t of ALL) {
      const m = bannerModel(t);
      const text = JSON.stringify(m) + VENDORS[t].credit;
      expect(text).not.toMatch(/atomic|transaction|terraform|pulumi|spacelift|env0|scalr|terramate|cdk/i);
      if (t !== "terragrunt-choudoufu") expect(text).not.toMatch(/gruntwork|terragrunt[^-]/i);
      if (t !== "atmos-choudoufu") expect(text).not.toMatch(/atmos|cloud posse/i);
    }
  });
});
