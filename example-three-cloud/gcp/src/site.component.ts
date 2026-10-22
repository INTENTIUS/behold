import { phase, type Component } from "@intentius/chant/components";

// The gcp member as one component: build its Config Connector manifest, then
// apply it into the project.
export const site: Component = {
  name: "site",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Build", [{ kind: "shell", cmd: "npx chant build src -o dist/site.yaml", reason: "the manifest gcp-apply applies is this member's own build" }]),
    phase("Apply", [{ kind: "gcp-apply", manifest: "dist/site.yaml", project: "three-cloud", noRollback: "a failed apply is fixed forward by applying the manifest again" }]),
  ],
};
