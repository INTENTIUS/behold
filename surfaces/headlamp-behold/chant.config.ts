// The Headlamp plugin's release member on behold's release train
// (../../chant.config.ts). The cut stamps the label into package.json, builds
// the plugin and packs the reproducible tarball with scripts/package.mjs, and
// the tarball and its .sha256 go on the GitHub release
// headlamp-behold-v<version>. The tarball holds package.json, so its checksum
// is known only once the label is: artifacthub-pkg.yml names a published
// release, and a pull request of its own moves it (with package.json) to the
// new version once it is out. `just headlamp-plugin` checks that pair.
export default {
  release: {
    tag: "headlamp-behold-v{version}",
    green: "forge-checks",
    version: { packages: ["."] },
    artifacts: [
      {
        name: "plugin",
        // package.mjs also writes the checksum into artifacthub-pkg.yml; the
        // committed file is put back, since it names the published release.
        build: "npm ci && npm run build && node scripts/package.mjs && git checkout -- artifacthub-pkg.yml",
        outputs: ["release/headlamp-behold-{version}.tar.gz", "release/headlamp-behold-{version}.tar.gz.sha256"],
      },
    ],
    check: ["npm run tsc", "npm test"],
    publish: [
      {
        type: "forge",
        forge: "github",
        repo: "INTENTIUS/behold",
        assets: ["artifact:plugin"],
        notes: { before: "Headlamp plugin {version}", generate: "commits" },
        latest: false,
        sbom: false,
      },
    ],
  },
};
