// behold#1005: every pin, floor and dependency that names the coming chant
// release follows CHANT_RELEASE, so one edit there (and
// `npx tsx scripts/chant-release.ts`) moves them all.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADOPTION_REPORT_CHANT_FLOOR, DRIFT_RECORD_CHANT_FLOOR, DRIFT_STREAM_CHANT_FLOOR } from "./chant-floors.ts";
import { CHANT_RELEASE, PUBLISHED_CHANT } from "./chant-release.ts";
import { chantRange, chantReleaseFiles, driftModuleSource } from "./chant-release-sync.ts";

const REPO = join(import.meta.dirname, "..");
const json = (file: string) => JSON.parse(readFileSync(join(REPO, file), "utf8")) as Record<string, any>;

describe("CHANT_RELEASE (behold#1005)", () => {
  it("every file it decides agrees with it (scripts/chant-release.ts --check)", () => {
    expect(chantReleaseFiles(REPO).filter((f) => f.differs).map((f) => f.file)).toEqual([]);
  });

  it("the unreleased floors are its version, the version a local build is stamped at", () => {
    expect([ADOPTION_REPORT_CHANT_FLOOR, DRIFT_RECORD_CHANT_FLOOR, DRIFT_STREAM_CHANT_FLOOR]).toEqual([CHANT_RELEASE.version, CHANT_RELEASE.version, CHANT_RELEASE.version]);
  });

  it("the exact pins move with the floors, in both modes", () => {
    const pin = (file: string, pkg: string) => (json(file).pins as { package?: string; version?: string }[]).find((p) => p.package === pkg)?.version;
    expect(pin("example-terraform-estate/chant.workspace.json", "@intentius/chant-lexicon-terraform")).toBe(CHANT_RELEASE.version);
    expect(pin("example-choudoufu-estate/chant.workspace.json", "@intentius/chant-lexicon-terraform")).toBe(CHANT_RELEASE.version);
    expect(pin("e2e/fixtures/pulumi-workspace/chant.workspace.json", "@intentius/chant-lexicon-pulumi")).toBe(CHANT_RELEASE.version);
  });

  it("behold's chant dependencies take the range the switch gives", () => {
    const pkg = json("package.json");
    expect(pkg.dependencies["@intentius/chant"]).toBe(chantRange(CHANT_RELEASE));
    expect(pkg.devDependencies["@intentius/chant-lexicon-sql"]).toBe(chantRange(CHANT_RELEASE));
  });

  it("unreleased, a dependency stays at the published chant and the drift module is looked for at run time", () => {
    const r = { version: "0.124.99", released: false };
    expect(chantRange(r)).toBe(`^${PUBLISHED_CHANT}`);
    expect(driftModuleSource(r)).toContain("await import(");
    expect(driftModuleSource(r)).not.toContain('from "@intentius/chant/drift-record"');
  });

  it("released, every range names the release, three-cloud pins and depends on both lexicons by version, and the drift module is a static import", () => {
    const r = { version: "0.124.99", released: true };
    expect(chantRange(r)).toBe("^0.124.99");
    expect(driftModuleSource(r)).toContain('import * as chant from "@intentius/chant/drift-record";');
    const files = Object.fromEntries(chantReleaseFiles(REPO, r).map((f) => [f.file, JSON.parse(f.file.endsWith(".json") ? f.want : "null")]));
    expect(files["example-three-cloud/chant.workspace.json"].pins).toEqual([
      { package: "@intentius/chant-lexicon-terraform", version: "0.124.99" },
      { package: "@intentius/chant-lexicon-pulumi", version: "0.124.99" },
    ]);
    expect(files["example-three-cloud/package.json"].dependencies).toMatchObject({
      "@intentius/chant": "^0.124.99",
      "@intentius/chant-lexicon-terraform": "^0.124.99",
      "@intentius/chant-lexicon-pulumi": "^0.124.99",
    });
    expect(files["package.json"].dependencies["@intentius/chant"]).toBe("^0.124.99");
    expect(files["example-choudoufu-estate/chant.workspace.json"].pins[0].version).toBe("0.124.99");
  });
});
