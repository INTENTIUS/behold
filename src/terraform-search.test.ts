import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEARCH_TERRAFORM_ROOTS_CHANT_FLOOR } from "./chant-floors.ts";
import { meetsFloor } from "./floor.ts";
import { discoverTerraformRoots, HCL_PARSER_PKG, readTerraformMember, resolvedVersion, TERRAFORM_LEXICON_PKG, writeTerraformScratchProject } from "./terraform-member.ts";

// #911: every query step of #908's demo runs `chant search` in the scratch
// project behold generates for a bare Terraform folder, so search has to see
// what `chant graph` sees there. The scratch project reaches chant and the
// lexicon through its `node_modules` symlink and the roots through its
// `estate` symlink; break either and this test fails.
//
// Two gates. The lexicon is an optional peer: skipped where it is not
// installed, except in CI's `peers` job (BEHOLD_REQUIRE_PEERS=1), where a
// missing peer fails. And chant below SEARCH_TERRAFORM_ROOTS_CHANT_FLOOR
// answers `(no matches)` here for every query (INTENTIUS/chant#4365), so the
// test waits for behold's chant to reach that floor.
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const ESTATE = join(import.meta.dirname, "..", "example-terraform-estate");
const peers = !!resolvedVersion(TERRAFORM_LEXICON_PKG) && !!resolvedVersion(HCL_PARSER_PKG);
const chant = resolvedVersion("@intentius/chant");
const searchReadsRoots = meetsFloor(chant, SEARCH_TERRAFORM_ROOTS_CHANT_FLOOR);

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("chant search in the scratch project for a bare Terraform folder (#911)", () => {
  it.skipIf((!peers && !REQUIRE_PEERS) || !searchReadsRoots)(
    `returns a row for each resource behold draws (needs chant ${SEARCH_TERRAFORM_ROOTS_CHANT_FLOOR}, INTENTIUS/chant#4365)`,
    { timeout: 120_000 },
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "behold-911-"));
      made.push(tmp);
      const project = writeTerraformScratchProject(ESTATE, discoverTerraformRoots(ESTATE), tmp);

      const run = spawnSync(join(project, "node_modules", ".bin", "chant"), ["search", "kind:Terraform::Resource"], { cwd: project, encoding: "utf8" });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      // One line per match: `<id>  <kind>  ...`. Footer lines start with a dash.
      const rows = run.stdout
        .split("\n")
        .filter((l) => / {2}Terraform::Resource\b/.test(l))
        .map((l) => l.split(/\s{2,}/)[0]!);
      expect(rows.length, run.stdout).toBeGreaterThan(0);

      // The same resources behold draws for that folder.
      const ir = await readTerraformMember(ESTATE, {});
      const drawn = ir.nodes.filter((n) => n.kind === "Terraform::Resource").map((n) => n.id);
      expect(rows.sort()).toEqual(drawn.sort());
    },
  );
});
