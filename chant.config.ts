// The root of behold's release train (behold#1211). Each product is a release
// member of chant.workspace.json with its own chant.config.ts, version and tag:
//
//   behold                    release/behold                     npm and a GitHub release, behold-v<version>
//   kubectl-behold            surfaces/kubectl-behold            krew archive on a GitHub release, kubectl-behold-v<version>
//   headlamp-behold           surfaces/headlamp-behold           plugin tarball on a GitHub release, headlamp-behold-v<version>
//   backstage-plugin-behold   surfaces/backstage-plugin-behold   dynamic-plugin image on ghcr.io, backstage-plugin-behold-v<version>
//   argocd-behold             surfaces/argocd-behold             extension tarball on a GitHub release, argocd-behold-v<version>
//
// `just release` dispatches .github/workflows/publish.yml, which `just
// release-workflow` renders from this file (never edit it by hand). The run
// takes main's head once its checks are green, runs `chant workspace train cut
// release`, which cuts every member that changed since its last release at a
// label past every version it already has, and publishes them. Each member's
// release stamps its label into the files its release.version names, so no
// commit bumps a version before a release. The MCP Registry listing runs after
// this workflow, in mcp-registry.yml. See
// https://intentius.io/chant/guide/release-a-monorepo/
export default {
  release: {
    green: "forge-checks",
    train: { env: "release" },
    workflow: { trigger: "dispatch", file: ".github/workflows/publish.yml" },
  },
};
