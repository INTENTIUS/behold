import { phase, type Component } from "@intentius/chant/components";

// The azure member as one component: build its ARM template, then deploy it
// into the resource group named after the environment.
export const site: Component = {
  name: "site",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Build", [{ kind: "shell", cmd: "npx chant build src -o dist/site.json", reason: "the template arm-deploy applies is this member's own build" }]),
    phase("Apply", [{ kind: "arm-deploy", template: "dist/site.json", resourceGroup: "local", location: "westeurope", noRollback: "a failed deploy is fixed forward by deploying the template again" }]),
  ],
};
