// The Argo CD UI extension's release member on behold's release train
// (../../chant.config.ts). The cut stamps the label into package.json, builds
// the extension and packs the reproducible tarball and checksums.txt, which go
// on the GitHub release argocd-behold-v<version>, where
// argocd-extension-installer downloads them from.
export default {
  release: {
    tag: "argocd-behold-v{version}",
    green: "forge-checks",
    // The extension compiles the Headlamp plugin's model in (tsconfig.json).
    sources: ["../headlamp-behold/src/model.ts"],
    version: { packages: ["."] },
    artifacts: [
      {
        name: "extension",
        build: "npm ci && npm run build && npm run package",
        outputs: ["release/argocd-behold-{version}.tar.gz", "release/checksums.txt"],
      },
    ],
    check: [
      "npm run tsc",
      "npm test",
      'test "$(node -p "require(\'./package.json\').version")" = "$CHANT_RELEASE_LABEL"',
    ],
    publish: [
      {
        type: "forge",
        forge: "github",
        repo: "INTENTIUS/behold",
        assets: ["artifact:extension"],
        notes: { before: "Argo CD UI extension {version}", generate: "commits" },
        latest: false,
        sbom: false,
      },
    ],
  },
};
