// @intentius/behold's release member on the release train (../../chant.config.ts).
// The package is the repository root, so this member names it with ../.. and
// lists in `sources` the paths a release of it is built from: a change to one
// of them puts behold in the next train, and a change only under surfaces/
// does not.
//
// The cut stamps the label into package.json and server.json, so the version
// on main never moves; scripts/release-check.sh then checks the packed tarball.
// The plugin and action files that pin a published behold move to it in a
// pull request of their own once it is out. The MCP Registry listing is
// mcp-registry.yml, after the publish.
export default {
  release: {
    tag: "behold-v{version}",
    legacyTags: ["behold-v"],
    green: "forge-checks",
    sources: [
      "../../bin",
      "../../src",
      "../../web",
      "../../schemas",
      "../../example",
      "../../example-writes",
      "../../example-k8s",
      "../../example-flux-estate",
      "../../example-argo-estate",
      "../../example-carve",
      "../../example-terraform-estate",
      "../../example-choudoufu-estate",
      "../../example-terralith",
      "../../example-three-cloud",
      "../../demos.json",
      "../../AGENTS.md",
      "../../LICENSE",
      "../../THIRD_PARTY.md",
      "../../licenses",
      "../../package.json",
      "../../package-lock.json",
      "../../server.json",
      "../../tsconfig.json",
      "../../tsconfig.build.json",
    ],
    version: { packages: ["../.."], files: ["../../server.json"], lockfile: false },
    check: ["bash ../../scripts/release-check.sh"],
    publish: [
      { type: "npm", packages: ["../.."], access: "public", stage: false },
      {
        type: "forge",
        forge: "github",
        repo: "INTENTIUS/behold",
        assets: [],
        notes: { generate: "forge" },
        sbom: false,
      },
    ],
  },
};
