// kubectl behold's release member on behold's release train
// (../../chant.config.ts). The cut stamps the label into krew/behold.yaml
// (spec.version and the release URL), builds the archive with
// scripts/package.mjs, and checks that the manifest names the archive's
// checksum and URL before anything is recorded. The archive and its .sha256
// go on the GitHub release kubectl-behold-v<version>. Once it is out, a pull
// request of its own moves krew/behold.yaml on main to that version.
export default {
  release: {
    tag: "kubectl-behold-v{version}",
    legacyTags: ["kubectl-behold-v"],
    green: "forge-checks",
    // The archive holds the repository's LICENSE beside the plugin.
    sources: ["../../LICENSE"],
    version: { files: [{ path: "krew/behold.yaml", format: "krew" }] },
    artifacts: [
      {
        name: "krew",
        build: "node scripts/package.mjs",
        outputs: ["release/kubectl-behold-v{version}.tar.gz", "release/kubectl-behold-v{version}.tar.gz.sha256"],
      },
    ],
    check: ["bash -n kubectl-behold", "node scripts/package.mjs --check", "cd release && sha256sum -c ./*.sha256"],
    publish: [
      {
        type: "forge",
        forge: "github",
        repo: "INTENTIUS/behold",
        assets: ["artifact:krew"],
        notes: { before: "kubectl behold {version}", generate: "commits" },
        latest: false,
        sbom: false,
      },
    ],
  },
};
