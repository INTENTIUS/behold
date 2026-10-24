import { describe, expect, it } from "vitest";
import { actNumeral, actOf, CODE_BASE, PRODUCTS, bannerModel, liveTool } from "./kiosk-banner.js";
import { VENDORS } from "./kiosk-vendor.js";

const ALL = ["choudoufu-compose", "terragrunt-choudoufu", "atmos-choudoufu", "chant-compose"];

describe("the demo banner model", () => {
  it("names the example the same for every demo but chant's, which runs across stacks; the logos say which one is live", () => {
    for (const t of ALL.filter((x) => x !== "chant-compose")) expect(bannerModel(t).name).toBe("One plan, one apply, across estates");
    expect(bannerModel("chant-compose").name).toBe("One plan, one apply, across stacks");
  });
  it("links the public example tree", () => {
    expect(bannerModel("choudoufu-compose").code.url).toBe("https://github.com/INTENTIUS/terragucci/tree/main/example-demo-choudoufu-compose");
    expect(bannerModel("atmos-choudoufu").code.url).toBe(`${CODE_BASE}example-demo-atmos-choudoufu`);
    expect(bannerModel("terragrunt-choudoufu").code.url).toBe(`${CODE_BASE}example-demo-terragrunt-choudoufu`);
    expect(bannerModel("chant-compose").code.url).toBe("https://github.com/INTENTIUS/terragucci/tree/main/example-demo-chant-compose");
  });
  it("names the demo's own products: every product with its logo, never OpenTofu", () => {
    expect(PRODUCTS.choudoufu.logo.src).toBe("/vendors/choudoufu.svg");
    expect(PRODUCTS.terragucci.logo.src).toBe("/vendors/terragucci.svg");
    expect(PRODUCTS.opentofu.logo).toBeNull();
    expect(PRODUCTS.terragrunt.logo.src).toBe("/vendors/terragrunt.svg");
    expect(PRODUCTS.atmos.logo.src).toBe("/vendors/atmos.svg");
    expect(bannerModel("choudoufu-compose").products.map((p) => p.name)).toEqual(["terragucci", "choudoufu"]);
    expect(bannerModel("terragrunt-choudoufu").products.map((p) => p.name)).toEqual(["Terragrunt", "choudoufu"]);
    expect(bannerModel("atmos-choudoufu").products.map((p) => p.name)).toEqual(["Atmos", "choudoufu"]);
    expect(bannerModel("chant-compose").products).toEqual([{ name: "chant", url: "https://intentius.io/chant/", logo: { src: "/vendors/chant.svg" } }]);
  });
  it("has no switcher and no replay: only the live demo's name, act, products and code", () => {
    for (const t of ALL) expect(bannerModel(t)).not.toHaveProperty("switcher");
  });
  it("follows demo.json's tool: the live demo, else null", () => {
    expect(liveTool({ demo: { tool: "atmos-choudoufu" } })).toBe("atmos-choudoufu");
    expect(liveTool({ tool: "terragrunt-choudoufu" })).toBe("terragrunt-choudoufu");
    expect(liveTool({ demo: { tool: "terraform" } })).toBeNull();
    expect(liveTool(null)).toBeNull();
    expect(liveTool({ demo: { tool: "atmos-choudoufu", scenario: "base" } })).toBeNull();
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
      if (t === "chant-compose") expect(text.replace(CODE_BASE, "")).not.toMatch(/choudoufu|terragrunt|opentofu|terragucci/i);
    }
  });
});

describe("the act after the title", () => {
  it("names the act from demo.json's index for this page's tool, in roman numerals", () => {
    expect(actOf("choudoufu-compose", { demo: { tool: "choudoufu-compose", index: 1, scenarios: 2 } })).toBe("Act I");
    expect(actOf("choudoufu-compose", { tool: "choudoufu-compose", index: 2, scenarios: 2 })).toBe("Act II");
    expect(actOf("choudoufu-compose", { demo: { tool: "other", index: 1, scenarios: 2 } })).toBeNull();
    expect(actOf("choudoufu-compose", { demo: { tool: "choudoufu-compose", index: 1, scenarios: 1 } })).toBeNull();
    expect(actOf("choudoufu-compose", null)).toBeNull();
    expect(actOf("choudoufu-compose", { demo: { tool: "choudoufu-compose", index: 4, scenarios: 6, act: 2, acts: 2 } })).toBe("Act II");
    expect(actOf("choudoufu-compose", { demo: { tool: "choudoufu-compose", index: 4, scenarios: 6, act: 1, acts: 1 } })).toBeNull();
    expect(actNumeral(3)).toBe("III");
    expect(actNumeral(4)).toBe("IV");
  });
  it("carries the act in the model", () => {
    expect(bannerModel("choudoufu-compose", "Act II").act).toBe("Act II");
  });
});
