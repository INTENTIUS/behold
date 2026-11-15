import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_ICONS, ICON_ROOT, iconsDrift, vendoredIcons } from "./generate-icons.ts";
import { VENDORED_ICONS } from "./icons.generated.ts";
import { splitVendoredSvg } from "./icon-svg.ts";

// #1069: the painter reads the icon corpus from a generated module, not from
// disk, so src/render.ts bundles for a browser. The module is checked in; this
// is the drift check `npm run check:icons` also runs.
describe("src/icons.generated.ts (#1069)", () => {
  it("is what web/icons gives", () => {
    expect(iconsDrift(), "run `npm run generate:icons`").toBe(false);
  });

  it("holds every vendored icon, split the way the disk read split it", () => {
    const rels = vendoredIcons();
    expect(rels.length).toBeGreaterThan(100);
    expect(Object.keys(VENDORED_ICONS).sort()).toEqual(rels);
    for (const rel of rels) {
      expect(VENDORED_ICONS[rel], rel).toEqual(splitVendoredSvg(readFileSync(join(ICON_ROOT, `${rel}.svg`), "utf8"), rel));
    }
  });

  it("imports nothing from Node", () => {
    expect(readFileSync(GENERATED_ICONS, "utf8")).not.toMatch(/from "node:/);
    expect(readFileSync(join(import.meta.dirname, "icon-packs.ts"), "utf8")).not.toMatch(/from "node:/);
  });
});
