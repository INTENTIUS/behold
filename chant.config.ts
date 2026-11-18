// What `chant release` cuts and publishes for @intentius/behold. `just
// release-workflow` renders .github/workflows/release.yml from it. See
// https://intentius.io/chant/cli/release/
//
// The version-bump PR still comes first: it moves package.json, server.json
// and the plugin and action files that name the release, so the label a run is
// dispatched with must be the version main already carries
// (scripts/release-check.sh refuses any other). The MCP Registry listing runs
// after this workflow, in mcp-registry.yml.
export default {
  release: {
    tag: "behold-v{version}",
    green: "forge-checks",
    check: ["bash scripts/release-check.sh"],
    publish: [
      { type: "npm", packages: ["."], access: "public", stage: false },
      {
        type: "forge",
        forge: "github",
        repo: "INTENTIUS/behold",
        assets: [],
        notes: { generate: "forge" },
        sbom: false,
      },
    ],
    workflow: { trigger: "dispatch", file: ".github/workflows/release.yml" },
  },
};
