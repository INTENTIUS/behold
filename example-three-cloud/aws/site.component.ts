import { phase, type Component } from "@intentius/chant/components";

// The aws member as one component: build its template, then apply it as the
// stack three-cloud-aws, the name the dns member reads its output from.
export const site: Component = {
  name: "site",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Build", [{ kind: "shell", cmd: "npx chant build src -o dist/site.json", reason: "the template cfn-deploy applies is this member's own build" }]),
    phase("Apply", [{ kind: "cfn-deploy", stack: "three-cloud-aws", template: "dist/site.json" }]),
  ],
};
