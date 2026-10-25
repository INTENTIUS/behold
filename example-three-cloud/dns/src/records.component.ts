import { memberOutputsComponent, phase, stackOutput, type Component } from "@intentius/chant/components";

// The azure member of chant.workspace.json, a choudoufu estate, as a
// component of this project (chant#4455): its one step reads the estate's
// outputs through choudoufu and never applies it. A change that touches
// azure/ plans dns against the azureEndpoint azure's own plan says it will
// have; while that is known only after azure applies, dns's plan names azure
// under its unresolved inputs, and dns applies once azure has.
export const azure = memberOutputsComponent("azure");

// The dns member as one component, applied after the three sites: its
// parameters are the endpoints they publish. azureEndpoint is wired from the
// azure component above. awsEndpoint and gcpEndpoint are still read from what
// is applied by the Build step (scripts/front-door.ts build-dns), which also
// points each health check at the emulator that answers for it and writes the
// template cfn-deploy applies as the stack named after the environment.
export const records: Component = {
  name: "records",
  archetype: "infra",
  dependsOn: ["azure"],
  deploy: [
    phase("Build", [{ kind: "shell", cmd: "npx tsx ../scripts/front-door.ts build-dns", reason: "the checks probe emulator addresses that only exist on this machine" }]),
    phase("Apply", [{ kind: "cfn-deploy", stack: "local", template: "dist/dns.json", inputs: { azureEndpoint: stackOutput("azure", "azureEndpoint") } }]),
  ],
};
