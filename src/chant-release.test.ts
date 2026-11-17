// behold#1005: every pin, floor and dependency that names the coming chant
// release follows CHANT_RELEASE, so one edit there (and
// `npx tsx scripts/chant-release.ts`) moves them all.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADOPTION_REPORT_CHANT_FLOOR, DRIFT_RECORD_CHANT_FLOOR, DRIFT_STREAM_CHANT_FLOOR, LEDGER_ROOT_MEMBER_CHANT_FLOOR } from "./chant-floors.ts";
import { CHANT_RELEASE, PUBLISHED_CHANT } from "./chant-release.ts";
import { chantRange, chantReleaseFiles, chantVersion, lexiconRange, lexiconVersion } from "./chant-release-sync.ts";

const REPO = join(import.meta.dirname, "..");
const json = (file: string) => JSON.parse(readFileSync(join(REPO, file), "utf8")) as Record<string, any>;

describe("CHANT_RELEASE (behold#1005)", () => {
  it("every file it decides agrees with it (scripts/chant-release.ts --check)", () => {
    expect(chantReleaseFiles(REPO).filter((f) => f.differs).map((f) => f.file)).toEqual([]);
  });

  it("the unreleased floors are its version, the version a local build is stamped at", () => {
    expect([ADOPTION_REPORT_CHANT_FLOOR, DRIFT_RECORD_CHANT_FLOOR, DRIFT_STREAM_CHANT_FLOOR, LEDGER_ROOT_MEMBER_CHANT_FLOOR]).toEqual([CHANT_RELEASE.version, CHANT_RELEASE.version, CHANT_RELEASE.version, CHANT_RELEASE.version]);
  });

  // behold#1015: an exact pin names the chant a plain `npm ci` installs, so
  // while unreleased it is the published chant; flipping moves it to the
  // release, where the floors already are.
  it("the exact pins name the published chant while unreleased, and move with the floors once released", () => {
    const pin = (file: string, pkg: string) => (json(file).pins as { package?: string; version?: string }[]).find((p) => p.package === pkg)?.version;
    const want = (pkg: string) => lexiconVersion(CHANT_RELEASE, pkg);
    expect(pin("example-terraform-estate/chant.workspace.json", "@intentius/chant-lexicon-terraform")).toBe(want("@intentius/chant-lexicon-terraform"));
    expect(pin("example-choudoufu-estate/chant.workspace.json", "@intentius/chant-lexicon-terraform")).toBe(want("@intentius/chant-lexicon-terraform"));
    expect(pin("e2e/fixtures/pulumi-workspace/chant.workspace.json", "@intentius/chant-lexicon-pulumi")).toBe(want("@intentius/chant-lexicon-pulumi"));
    expect(pin("e2e/fixtures/k8s-workspace/chant.workspace.json", "@intentius/chant-lexicon-k8s")).toBe(want("@intentius/chant-lexicon-k8s"));
    const pins = (r: { version: string; released: boolean }) =>
      Object.fromEntries(chantReleaseFiles(REPO, r).filter((f) => f.file.endsWith("chant.workspace.json") && f.file !== "example-three-cloud/chant.workspace.json").map((f) => [f.file, (JSON.parse(f.want) as { pins: { version?: string }[] }).pins[0].version]));
    expect(Object.values(pins({ version: "0.124.99", released: false }))).toEqual([PUBLISHED_CHANT, PUBLISHED_CHANT, PUBLISHED_CHANT, PUBLISHED_CHANT]);
    expect(Object.values(pins({ version: "0.124.99", released: true }))).toEqual(["0.124.99", "0.124.99", "0.124.99", "0.124.99"]);
  });

  // The README's install line for the terraform reader names behold's own range.
  it("example-terraform-estate/README.md's install line names the range behold declares", () => {
    expect(readFileSync(join(REPO, "example-terraform-estate", "README.md"), "utf8")).toContain(`@intentius/chant-lexicon-terraform@${lexiconRange(CHANT_RELEASE, "@intentius/chant-lexicon-terraform")} `);
  });

  it("behold's chant dependencies take the range the switch gives", () => {
    const pkg = json("package.json");
    expect(pkg.dependencies["@intentius/chant"]).toBe(chantRange(CHANT_RELEASE));
    expect(pkg.dependencies["@intentius/chant-lexicon-sql"]).toBe(lexiconRange(CHANT_RELEASE, "@intentius/chant-lexicon-sql"));
    expect(pkg.dependencies["@intentius/chant-lexicon-k8s"]).toBe(lexiconVersion(CHANT_RELEASE, "@intentius/chant-lexicon-k8s"));
    expect(pkg.devDependencies["@intentius/chant-lexicon-aws"]).toBe(lexiconRange(CHANT_RELEASE, "@intentius/chant-lexicon-aws"));
  });

  it("unreleased, a dependency stays at the published chant", () => {
    const r = { version: "0.124.99", released: false };
    expect(chantRange(r)).toBe(`^${PUBLISHED_CHANT}`);
  });

  it("released, every range names the release, and three-cloud pins and depends on both lexicons by version", () => {
    const r = { version: "0.124.99", released: true };
    expect(chantRange(r)).toBe("^0.124.99");
    const files = Object.fromEntries(chantReleaseFiles(REPO, r).map((f) => [f.file, JSON.parse(f.want)]));
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

  // A train publishes only the members that changed, so core can be on a
  // newer release than the lexicons; each then names its own.
  it("released with core ahead of the lexicons, chant takes the release and every lexicon and the k8s client take theirs", () => {
    const r = { version: "0.124.102", released: true, lexicons: "0.124.101" };
    expect(chantVersion(r)).toBe("0.124.102");
    const files = Object.fromEntries(chantReleaseFiles(REPO, r).map((f) => [f.file, JSON.parse(f.want)]));
    const deps = { ...files["package.json"].dependencies, ...files["package.json"].devDependencies };
    expect(deps["@intentius/chant"]).toBe("^0.124.102");
    expect(deps["@intentius/chant-k8s-client"]).toBe("^0.124.101");
    expect(deps["@intentius/chant-lexicon-k8s"]).toBe("0.124.101");
    expect(deps["@intentius/chant-lexicon-sql"]).toBe("^0.124.101");
    expect(files["example-three-cloud/package.json"].dependencies).toMatchObject({ "@intentius/chant": "^0.124.102", "@intentius/chant-lexicon-terraform": "^0.124.101" });
    expect(files["example-three-cloud/chant.workspace.json"].pins[0].version).toBe("0.124.101");
    expect(files["e2e/fixtures/k8s-workspace/chant.workspace.json"].pins[0].version).toBe("0.124.101");
  });

  // Each lexicon on the release its own train left it at (chant 0.124.104 with k8s and aws on 0.124.103).
  it("released with a version per lexicon, each dependency and pin names its own", () => {
    const r = { version: "0.124.104", released: true, lexicons: { "@intentius/chant-lexicon-k8s": "0.124.103", "@intentius/chant-lexicon-aws": "0.124.103", "@intentius/chant-lexicon-terraform": "0.124.102" } };
    expect(lexiconVersion(r, "@intentius/chant-lexicon-sql")).toBe("0.124.104");
    const files = Object.fromEntries(chantReleaseFiles(REPO, r).map((f) => [f.file, JSON.parse(f.want)]));
    const deps = { ...files["package.json"].dependencies, ...files["package.json"].devDependencies };
    expect(deps["@intentius/chant"]).toBe("^0.124.104");
    expect(deps["@intentius/chant-lexicon-k8s"]).toBe("0.124.103");
    expect(deps["@intentius/chant-lexicon-aws"]).toBe("^0.124.103");
    expect(deps["@intentius/chant-lexicon-terraform"]).toBe("^0.124.102");
    expect(files["example-three-cloud/package.json"].dependencies["@intentius/chant-lexicon-aws"]).toBe("^0.124.103");
    expect(files["example-terraform-estate/chant.workspace.json"].pins[0].version).toBe("0.124.102");
    expect(files["e2e/fixtures/k8s-workspace/chant.workspace.json"].pins[0].version).toBe("0.124.103");
  });
});
