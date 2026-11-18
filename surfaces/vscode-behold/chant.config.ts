// The VS Code extension's release member on behold's release train
// (../../chant.config.ts). The cut stamps the label into package.json, builds
// the extension (its reader and viewer come from the repository's src/, which
// the workflow's install at the root provides), packages the .vsix within its
// size budget, and runs the typecheck and the unit tests. The .vsix and
// checksums.txt go on the GitHub release vscode-behold-v<version>.
//
// The Visual Studio Marketplace and Open VSX are not targets yet: neither has
// its credentials set up (PUBLISHING.md), and the train's workflow can't yet
// give a job the environment the Marketplace sign-in needs, or skip that
// sign-in until it exists (INTENTIUS/chant#5318).
export default {
  release: {
    tag: "vscode-behold-v{version}",
    green: "forge-checks",
    // The extension bundles behold's reader and viewer from the repository.
    sources: ["../../src", "../../scripts/build-viewer.mts"],
    version: { packages: ["."] },
    artifacts: [
      {
        name: "vsix",
        build: 'npm ci && npm run build && node scripts/package.mjs --out "dist/behold-$CHANT_RELEASE_LABEL.vsix"',
        outputs: ["dist/behold-{version}.vsix"],
      },
      { name: "vsix-checksums", checksums: "dist/checksums.txt", of: ["vsix"] },
    ],
    check: ["npm run tsc", "npm test"],
    publish: [
      {
        type: "forge",
        forge: "github",
        repo: "INTENTIUS/behold",
        assets: ["artifact:vsix", "artifact:vsix-checksums"],
        notes: { before: "VS Code extension {version}", generate: "commits" },
        latest: false,
        sbom: false,
      },
    ],
  },
};
