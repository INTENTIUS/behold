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

  // #824: dns and three clouds, and each cloud publishes the output dns reads
  // by the same name, which is the join the cross-member edge is drawn on.
  // choudoufu#2246: the azure site is a choudoufu estate, so its output is a
  // Terraform output of that name, and the declaration pins the terraform
  // lexicon (which supplies the choudoufu kind) at the version its lockfile
  // installs.
  it("example-three-cloud declares dns and three clouds, azure a choudoufu estate, each cloud's output named like a dns parameter", () => {
    const decl = declaration("example-three-cloud");
    expect(decl.members).toEqual(["dns", "aws", "azure", "gcp"].map((n) => ({ name: n, dir: n, kind: n === "azure" ? "choudoufu" : "chant" })));
    const lock = JSON.parse(readFileSync(join(REPO, "example-three-cloud", "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
    expect(decl.pins?.find((p) => p.package === TERRAFORM_LEXICON)?.version).toBe(lock.packages[`node_modules/${TERRAFORM_LEXICON}`]?.version);
    const dns = readFileSync(join(REPO, "example-three-cloud", "dns", "src", "route53.ts"), "utf8");
    for (const cloud of ["aws", "gcp"]) {
      const site = readFileSync(join(REPO, "example-three-cloud", cloud, "src", "site.ts"), "utf8");
      expect(site, cloud).toContain(`"${cloud}Endpoint")`);
      expect(dns, cloud).toContain(`export const ${cloud}Endpoint = new Parameter(`);
    }
    const estate = readFileSync(join(REPO, "example-three-cloud", "azure", "site.tf"), "utf8");
    expect(estate).toContain(`output "azureEndpoint" {`);
    expect(dns).toContain("export const azureEndpoint = new Parameter(");
    expect(readFileSync(join(REPO, "example-three-cloud", "azure", "main.tf"), "utf8")).toMatch(/\n  live \{\n    estate = "three-cloud-azure"/);
  });

  // chant#4455: dns reads azure's azureEndpoint through chant, from a
  // member-outputs component named after the member, and names the estate as
  // its terraform root so a change under azure/ brings dns into the change.
  it("example-three-cloud's dns reads azureEndpoint from the azure member's outputs", () => {
    const records = readFileSync(join(REPO, "example-three-cloud", "dns", "src", "records.component.ts"), "utf8");
    expect(records).toContain(`export const azure = memberOutputsComponent("azure");`);
    expect(records).toContain(`dependsOn: ["azure"]`);
    expect(records).toContain(`inputs: { azureEndpoint: stackOutput("azure", "azureEndpoint") }`);
    const config = readFileSync(join(REPO, "example-three-cloud", "dns", "chant.config.ts"), "utf8");
    expect(config).toContain(`lexicons: ["aws", "terraform"]`);
    expect(config).toContain(`roots: { azure: { dir: "../azure" } }`);
  });

  const installed = installedVersion(TERRAFORM_LEXICON, REPO);
  it.skipIf(!installed && !REQUIRE_PEERS)("pins the terraform lexicon at the version installed beside behold", () => {
    for (const example of ["example-terraform-estate", "example-choudoufu-estate"]) {
      const pin = declaration(example).pins?.find((p) => p.package === TERRAFORM_LEXICON);
      expect(pin?.version, example).toBe(installed);
    }
  });
});
