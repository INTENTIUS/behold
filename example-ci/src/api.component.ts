import { phase, type Component } from "@intentius/chant/components/component";
import { step } from "@intentius/chant/components";

const cfnDeploy = step<{ template: string }>("cfn-deploy");

export const api: Component = {
  name: "api",
  dependsOn: ["web"],
  deploy: [phase("Apply", [cfnDeploy({ template: "api.template.json" })])],
};
