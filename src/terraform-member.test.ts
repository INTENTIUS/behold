import { describe, it, expect, afterAll } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { memberSourceStamp } from "./member-ir.ts";
import {
  ESTATE_LINK,
  HCL_PARSER_PKG,
  TERRAFORM_LEXICON_PKG,
  discoverTerraformRoots,
  hasTerraformRoots,
  readTerraformMember,
  terraformReaderState,
  terraformRootsNote,
  terraformScratchConfig,
  terraformScratchDir,
  writeTerraformScratchProject,
} from "./terraform-member.ts";

// Fixture provenance (#384). `src/__fixtures__/terraform-estate/` is water
// park's `access/` (INTENTIUS/waterpark) reduced to the five shapes discovery
// has to tell apart, with the `.tf` bodies trimmed to the blocks that decide:
//
//   envs/prod/         a root — `terraform { required_providers }`, a provider
//                      block, a resource, and a `module` call into modules/
//   baseline/          a root with NO provider block, called as a module by
//                      prod exactly as water park's is
//   modules/persona/   the shared module. Its versions.tf is byte-for-byte
//                      baseline's, which is why #384's proposed probe ("what a
//                      root has and a called module does not") is not enough
//   backends/          the backend fragment copied into a root — a `terraform`
//                      block and nothing to draw
//   envs/dev/          a README and no `.tf`, so it is neither drawn nor
//                      reported
const HERE = dirname(fileURLToPath(import.meta.url));
const ESTATE = join(HERE, "__fixtures__", "terraform-estate");

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A temp directory that is nobody's estate — used as a `from` with no
 * node_modules above it, which is what "the lexicon is not installed" looks
 * like from a resolution's point of view. */
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

describe("root discovery (#384)", () => {
  it("finds the roots and says why each other directory of .tf is not one", () => {
    const scan = discoverTerraformRoots(ESTATE);

    expect(scan.roots.map((r) => r.dir)).toEqual(["baseline", "envs/prod"]);
    expect(scan.roots.map((r) => r.name)).toEqual(["baseline", "prod"]);
    expect(scan.skipped).toEqual([
      { dir: "backends", why: "no resource, data or module block — nothing to draw" },
      { dir: "modules/persona", why: "called as a module, never applied on its own" },
    ]);
  });

  it("keeps a called module out even though its terraform block is the root's, byte for byte", () => {
    const versions = (rel: string): string => readFileSync(join(ESTATE, rel, "versions.tf"), "utf8");
    expect(versions("modules/persona")).toBe(versions("baseline"));
    expect(discoverTerraformRoots(ESTATE).roots.some((r) => r.dir.startsWith("modules/"))).toBe(false);
  });

  it("does not report a directory that holds no .tf at all", () => {
    const scan = discoverTerraformRoots(ESTATE);
    expect([...scan.roots.map((r) => r.dir), ...scan.skipped.map((s) => s.dir)]).not.toContain("envs/dev");
  });

  it("reads one root pointed at directly — the `behold serve access/envs/prod` case", () => {
    const scan = discoverTerraformRoots(join(ESTATE, "envs", "prod"));
    expect(scan.roots).toEqual([{ name: "prod", dir: "." }]);
    expect(hasTerraformRoots(join(ESTATE, "envs", "prod"))).toBe(true);
  });

  it("probes a module pointed at directly as a root — it is only ever a module relative to a caller", () => {
    expect(hasTerraformRoots(join(ESTATE, "modules", "persona"))).toBe(true);
  });

  it("claims nothing that is not Terraform", () => {
    expect(hasTerraformRoots(tmp("behold-tf-empty-"))).toBe(false);
    expect(hasTerraformRoots(join(ESTATE, "envs", "dev"))).toBe(false);
    expect(hasTerraformRoots(join(ESTATE, "backends"))).toBe(false);
  });

  it("gives two roots with the same basename their full paths, so neither quietly takes the name", () => {
    const root = tmp("behold-tf-collide-");
    for (const rel of ["a/prod", "b/prod"]) {
      mkdirSync(join(root, ...rel.split("/")), { recursive: true });
      writeFileSync(join(root, ...rel.split("/"), "main.tf"), 'terraform {}\nresource "aws_s3_bucket" "b" {}\n');
    }
    expect(discoverTerraformRoots(root).roots).toEqual([
      { name: "a-prod", dir: "a/prod" },
      { name: "b-prod", dir: "b/prod" },
    ]);
  });

  it("never walks into a Terraform working directory, which holds a copy of every module it fetched", () => {
    const root = tmp("behold-tf-dotdir-");
    mkdirSync(join(root, ".terraform", "modules", "x"), { recursive: true });
    writeFileSync(join(root, ".terraform", "modules", "x", "main.tf"), 'terraform {}\nresource "aws_s3_bucket" "b" {}\n');
    expect(discoverTerraformRoots(root)).toEqual({ roots: [], skipped: [] });
  });
});

describe("the note (#384)", () => {
  it("names the roots and the skips with their reasons", () => {
    expect(terraformRootsNote(discoverTerraformRoots(ESTATE))).toBe(
      "2 roots — baseline, prod; skipped backends (no resource, data or module block — nothing to draw), modules/persona (called as a module, never applied on its own)",
    );
  });

  it("counts the skips it does not name, because a note is a line and not a report", () => {
    const scan = { roots: [{ name: "prod", dir: "envs/prod" }], skipped: [1, 2, 3, 4, 5].map((n) => ({ dir: `m${n}`, why: "why" })) };
    expect(terraformRootsNote(scan)).toBe("1 root — prod; skipped m1 (why), m2 (why), m3 (why), +2 more");
  });

  it("says nothing when there is nothing to say", () => {
    expect(terraformRootsNote({ roots: [], skipped: [{ dir: "x", why: "why" }] })).toBeUndefined();
    expect(terraformRootsNote({ roots: [{ name: "prod", dir: "." }], skipped: [] })).toBe("1 root — prod");
  });
});

describe("the scratch project (#384)", () => {
  it("writes nothing under the estate — the whole write boundary this feature has to hold", () => {
    const before = memberSourceStamp(ESTATE);
    const project = writeTerraformScratchProject(ESTATE, discoverTerraformRoots(ESTATE));
    made.push(project);

    expect(memberSourceStamp(ESTATE)).toBe(before);
    expect(project.startsWith(ESTATE + sep)).toBe(false);
    expect(existsSync(join(ESTATE, "chant.config.ts"))).toBe(false);
    expect(existsSync(join(ESTATE, ".behold"))).toBe(false);
  });

  it("is behold's own, named for scratch discipline, and the same directory every run", () => {
    const first = terraformScratchDir(ESTATE);
    expect(first).toBe(terraformScratchDir(ESTATE));
    expect(first.split(sep).at(-1)!.startsWith("behold-tf-")).toBe(true);
    expect(terraformScratchDir(join(ESTATE, "baseline"))).not.toBe(first);
  });

  it("refuses outright when the temp directory it was handed lives inside the estate", () => {
    expect(() => terraformScratchDir(ESTATE, join(ESTATE, "tmp"))).toThrow(/inside the estate/);
  });

  it("holds the config and the two symlinks the read needs, and rewrites the config only when it changed", () => {
    const project = writeTerraformScratchProject(ESTATE, discoverTerraformRoots(ESTATE));
    made.push(project);
    const config = join(project, "chant.config.ts");
    expect(lstatSync(join(project, ESTATE_LINK)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(project, ESTATE_LINK))).toBe(ESTATE);

    const stamp = memberSourceStamp(project);
    writeTerraformScratchProject(ESTATE, discoverTerraformRoots(ESTATE));
    expect(memberSourceStamp(project)).toBe(stamp);
    expect(readFileSync(config, "utf8")).toContain(`"prod": { dir: "${ESTATE_LINK}/envs/prod" }`);
  });

  it("names every root through the estate symlink, sorted, so the same estate generates the same bytes", () => {
    const config = terraformScratchConfig(discoverTerraformRoots(ESTATE), ESTATE_LINK);
    expect(config).toContain(`import "${TERRAFORM_LEXICON_PKG}";`);
    expect(config).toContain('lexicons: ["terraform"]');
    expect(config.indexOf('"baseline"')).toBeLessThan(config.indexOf('"prod"'));
    // A root that IS the served directory is the symlink itself, not `<link>/.`.
    expect(terraformScratchConfig({ roots: [{ name: "prod", dir: "." }], skipped: [] }, ESTATE_LINK)).toContain(`"prod": { dir: "${ESTATE_LINK}" }`);
  });
});

describe("the reader behold does not install (#384)", () => {
  it("refuses politely, naming both packages, where it looked, and the one install line", () => {
    const state = terraformReaderState(tmp("behold-tf-nolexicon-"));

    expect(state.refusal!.code).toBe("terraform-lexicon");
    expect(state.refusal!.error).toContain(TERRAFORM_LEXICON_PKG);
    expect(state.refusal!.error).toContain(HCL_PARSER_PKG);
    expect(state.refusal!.error).toContain("behold does not install");
    expect(state.refusal!.remedy).toMatch(/^Install .* beside behold, then reload\.$/);
    // The declared ranges, read from behold's own manifest — so the line and
    // the package.json cannot drift apart.
    expect(state.refusal!.remedy).toContain(`${TERRAFORM_LEXICON_PKG}@${state.lexicon.range}`);
    expect(state.lexicon.range).toMatch(/^\^?\d/);
  });

  it("is what a read throws, with the refusal on the error the routes render", async () => {
    const state = terraformReaderState(tmp("behold-tf-nolexicon-"));
    const stamped = memberSourceStamp(ESTATE);
    await expect(readTerraformMember(ESTATE, {}, state)).rejects.toMatchObject({
      refusal: { code: "terraform-lexicon", remedy: state.refusal!.remedy },
    });
    // And it wrote nothing on the way out: the refusal comes before the scan
    // and before the scratch project.
    expect(memberSourceStamp(ESTATE)).toBe(stamped);
  });

  it("refuses a directory with no root the same way, pointing at the roots instead of an install", async () => {
    const empty = tmp("behold-tf-noroots-");
    await expect(readTerraformMember(empty, {}, { lexicon: { pkg: TERRAFORM_LEXICON_PKG, version: "0.61.0" }, parser: { pkg: HCL_PARSER_PKG, version: "0.21.0" }, from: empty })).rejects.toThrow(
      /holds no Terraform root/,
    );
  });
});
