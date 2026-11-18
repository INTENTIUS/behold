// The Backstage plugin's release member on behold's release train
// (../../chant.config.ts). The cut stamps the label into package.json, exports
// the plugin as a Red Hat Developer Hub dynamic plugin and builds its OCI
// image, saved to an archive the release records; the publish pushes that
// image to ghcr.io/intentius/backstage-plugin-behold:<version> with the run's
// token. The check against two Backstage releases runs on pull requests
// (.github/workflows/surfaces.yml).
//
// The npm release of @intentius/backstage-plugin-behold is separate and stays
// a maintainer step. The derived "-dynamic" package is only ever inside the image.
export default {
  release: {
    tag: "backstage-plugin-behold-v{version}",
    green: "forge-checks",
    version: { packages: ["."] },
    images: [
      {
        name: "dynamic-plugin",
        build:
          "npm ci --ignore-scripts && CONTAINER_TOOL=docker IMAGE=backstage-plugin-behold:chant-release npm run package-dynamic && mkdir -p dist && docker save backstage-plugin-behold:chant-release -o dist/backstage-plugin-behold.tar",
        archive: "dist/backstage-plugin-behold.tar",
      },
    ],
    check: [
      "npm run tsc",
      "npm test",
      'test "$(node -p "require(\'./package.json\').version")" = "$CHANT_RELEASE_LABEL"',
    ],
    publish: [
      {
        type: "oci",
        image: "dist/backstage-plugin-behold.tar",
        repository: "ghcr.io/intentius/backstage-plugin-behold",
        tags: ["{version}"],
        sbom: false,
      },
    ],
  },
};
