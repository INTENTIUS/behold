import { phase, type Component } from "@intentius/chant/components/component";
import { step } from "@intentius/chant/components";

const cfnDeploy = step<{ template: string }>("cfn-deploy");

export const web: Component = {
  name: "web",
  dependsOn: [],
  deploy: [phase("Apply", [cfnDeploy({ template: "web.template.json" })])],
};
