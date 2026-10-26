import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHANT_RELEASE, PUBLISHED_CHANT } from "./chant-release.ts";
import { discoverTerraformRoots } from "./terraform-member.ts";
import { installedVersion, TERRAFORM_LEXICON } from "./workspace-convert.ts";

// CI's `peers` job sets BEHOLD_REQUIRE_PEERS=1 (scripts/install-peers.sh): there a
// missing peer fails the test instead of skipping it.
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";

// #464: the bundled estates declare themselves as chant workspaces, written by
// `behold doctor --fix`. Pinned here: the declarations still say what behold's
// own discovery sees, and the lexicon pin is the version a plain `npm ci`
// installs beside behold, which is where chant looks for it from an example in
// this checkout (a pin chant can't find fails `chant workspace check` with
// WSP002).
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
  // Terraform output of that name. behold#1000: the aws site is a Pulumi
  // program on plunge, its output a stack output of that name. behold#1005:
  // the two lexicons that supply those kinds follow CHANT_RELEASE
  // (src/chant-release.ts). Until it is released they are pinned by path, at
  // node_modules, so the pin reads whichever build is installed there (no
  // release has the pulumi lexicon yet, and the demo runs on a local build of
  // chant). Once it is, both are pinned by package at the release, and the
  // example's package.json depends on that release of each.
  it("example-three-cloud declares dns and three clouds on three engines, each cloud's output named like a dns parameter", () => {
    const decl = declaration("example-three-cloud");
    const kind: Record<string, string> = { dns: "chant", aws: "pulumi", azure: "choudoufu", gcp: "chant" };
    expect(decl.members).toEqual(["dns", "aws", "azure", "gcp"].map((n) => ({ name: n, dir: n, kind: kind[n] })));
    const PULUMI_LEXICON = "@intentius/chant-lexicon-pulumi";
    const deps = (JSON.parse(readFileSync(join(REPO, "example-three-cloud", "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies;
    if (CHANT_RELEASE.released) {
      expect(decl.pins).toEqual([{ package: TERRAFORM_LEXICON, version: CHANT_RELEASE.version }, { package: PULUMI_LEXICON, version: CHANT_RELEASE.version }]);
      expect(deps[TERRAFORM_LEXICON]).toBe(`^${CHANT_RELEASE.version}`);
      expect(deps[PULUMI_LEXICON]).toBe(`^${CHANT_RELEASE.version}`);
    } else {
      expect(decl.pins).toEqual([{ path: `node_modules/${TERRAFORM_LEXICON}` }, { path: `node_modules/${PULUMI_LEXICON}` }]);
      expect(deps[PULUMI_LEXICON]).toBeUndefined();
    }
    const dns = readFileSync(join(REPO, "example-three-cloud", "dns", "src", "route53.ts"), "utf8");
    const gcp = readFileSync(join(REPO, "example-three-cloud", "gcp", "src", "site.ts"), "utf8");
    expect(gcp).toContain(`"gcpEndpoint")`);
    expect(dns).toContain("export const gcpEndpoint = new Parameter(");
    const program = readFileSync(join(REPO, "example-three-cloud", "aws", "index.ts"), "utf8");
    expect(program).toContain("export const awsEndpoint = alb.dnsName;");
    expect(dns).toContain("export const awsEndpoint = new Parameter(");
    const project = readFileSync(join(REPO, "example-three-cloud", "aws", "Pulumi.yaml"), "utf8");
    expect(project).toMatch(/\nbackend:\n  url: plunge\+file:\/\/\.\/\.plunge\n/);
    const pkg = JSON.parse(readFileSync(join(REPO, "example-three-cloud", "aws", "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies).toEqual({ "@pulumi/aws": "7.51.1", "@pulumi/pulumi": "3.272.0" });
    expect(existsSync(join(REPO, "example-three-cloud", "aws", "chant.config.ts"))).toBe(false);
    const estate = readFileSync(join(REPO, "example-three-cloud", "azure", "site.tf"), "utf8");
    expect(estate).toContain(`output "azureEndpoint" {`);
    expect(dns).toContain("export const azureEndpoint = new Parameter(");
    expect(readFileSync(join(REPO, "example-three-cloud", "azure", "main.tf"), "utf8")).toMatch(/\n  live \{\n    estate = "three-cloud-azure"/);
  });

  // chant#4455: dns reads azure's azureEndpoint and aws's awsEndpoint through
  // chant, from a member-outputs component named after each member, and
  // names the estate as its terraform root, signalOnly, so a change under
  // azure/ brings dns into the change. It lists pulumi for the aws member's outputs.
  it("example-three-cloud's dns reads azureEndpoint and awsEndpoint from the members' outputs", () => {
    const records = readFileSync(join(REPO, "example-three-cloud", "dns", "src", "records.component.ts"), "utf8");
    expect(records).toContain(`export const azure = memberOutputsComponent("azure");`);
    expect(records).toContain(`export const aws = memberOutputsComponent("aws");`);
    expect(records).toContain(`dependsOn: ["azure", "aws"]`);
    expect(records).toContain(`inputs: { azureEndpoint: stackOutput("azure", "azureEndpoint"), awsEndpoint: stackOutput("aws", "awsEndpoint") }`);
    const config = readFileSync(join(REPO, "example-three-cloud", "dns", "chant.config.ts"), "utf8");
    expect(config).toContain(`lexicons: ["aws", "terraform", "pulumi"]`);
    // behold#1016: the azure root is marked signalOnly (chant#4484), and the
    // key is dropped when the installed terraform lexicon predates it.
    expect(config).toContain(`roots: { azure: AZURE_ROOT }`);
    expect(config).toContain(`{ dir: "../azure", signalOnly: true }`);
    expect(config).toContain(`if (!terraformRootSchema.safeParse(AZURE_ROOT).success) delete AZURE_ROOT.signalOnly;`);
  });

  // behold#1015: the pin names the chant a plain `npm ci` installs, the
  // published one while CHANT_RELEASE is unreleased. A local build of chant
  // stamped at CHANT_RELEASE.version is the other lexicon that may sit beside
  // behold then; `behold demo` re-pins its copy at whichever is installed
  // (src/demo-pins.ts), so both serve.
  const installed = installedVersion(TERRAFORM_LEXICON, REPO);
  it.skipIf(!installed && !REQUIRE_PEERS)("pins the terraform lexicon at the chant npm installs beside behold", () => {
    const want = CHANT_RELEASE.released ? CHANT_RELEASE.version : PUBLISHED_CHANT;
    for (const example of ["example-terraform-estate", "example-choudoufu-estate"]) {
      const pin = declaration(example).pins?.find((p) => p.package === TERRAFORM_LEXICON);
      expect(pin?.version, example).toBe(want);
    }
    const served = CHANT_RELEASE.released ? [CHANT_RELEASE.version] : [PUBLISHED_CHANT, CHANT_RELEASE.version];
    expect(served, `the terraform lexicon installed beside behold is ${installed}`).toContain(installed);
  });
});
