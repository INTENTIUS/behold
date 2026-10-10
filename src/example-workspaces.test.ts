import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverTerraformRoots } from "./terraform-member.ts";
import { installedVersion, TERRAFORM_LEXICON } from "./workspace-convert.ts";

// CI's `peers` job sets BEHOLD_REQUIRE_PEERS=1 (scripts/install-peers.sh): there a
// missing peer fails the test instead of skipping it.
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";

// #464: the bundled estates declare themselves as chant workspaces, written by
// `behold doctor --fix`. Pinned here: the declarations still say what behold's
// own discovery sees, and the lexicon pin is the version installed beside
// behold, which is where chant looks for it from an example in this checkout
// (a pin chant can't find fails `chant workspace check` with WSP002).
const REPO = join(import.meta.dirname, "..");

interface Declaration {
  name: string;
  pins?: { package?: string; version?: string }[];
  members: { name: string; dir: string; kind: string }[];
}
const declaration = (example: string): Declaration => JSON.parse(readFileSync(join(REPO, example, "chant.workspace.json"), "utf8")) as Declaration;

describe("the bundled estates' workspace declarations", () => {
  it("example-terraform-estate declares one member per root discovery finds", () => {
    const decl = declaration("example-terraform-estate");
    const roots = discoverTerraformRoots(join(REPO, "example-terraform-estate")).roots;
    expect(decl.members.map((m) => [m.name, m.dir, m.kind]).sort()).toEqual(roots.map((r) => [r.name, r.dir, "terraform"]).sort());
  });

  it("example-choudoufu-estate declares its four estates", () => {
    expect(declaration("example-choudoufu-estate").members).toEqual(
      ["monolith", "team-a", "team-b", "team-c"].map((n) => ({ name: n, dir: n, kind: "choudoufu" })),
    );
    // The member list moved to the declaration; .behold.json no longer holds one.
    expect(existsSync(join(REPO, "example-choudoufu-estate", ".behold.json"))).toBe(false);
  });

  it("example-argo-estate and example-flux-estate declare their three chant projects, pinned at the chant their lockfile installs", () => {
    for (const example of ["example-argo-estate", "example-flux-estate"]) {
      const decl = declaration(example);
      expect(decl.members, example).toEqual(["control-plane", "app-a", "app-b"].map((n) => ({ name: n, dir: n, kind: "chant" })));
      // ws-021: the root's pinned chant reads the declaration, and a pin that
      // is not the installed version is a refusal (root-chant-required).
      const lock = JSON.parse(readFileSync(join(REPO, example, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
      const locked = lock.packages["node_modules/@intentius/chant"]?.version;
      expect(decl.pins?.find((p) => p.package === "@intentius/chant")?.version, example).toBe(locked);
    }
  });

  const installed = installedVersion(TERRAFORM_LEXICON, REPO);
  it.skipIf(!installed && !REQUIRE_PEERS)("pins the terraform lexicon at the version installed beside behold", () => {
    for (const example of ["example-terraform-estate", "example-choudoufu-estate"]) {
      const pin = declaration(example).pins?.find((p) => p.package === TERRAFORM_LEXICON);
      expect(pin?.version, example).toBe(installed);
    }
  });
});
