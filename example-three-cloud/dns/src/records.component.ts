import { memberOutputsComponent, phase, stackOutput, type Component } from "@intentius/chant/components";

// The azure member of chant.workspace.json, a choudoufu estate, as a
// component of this project (chant#4455): its one step reads the estate's
// outputs through choudoufu and never applies it. A change that touches
// azure/ plans dns against the azureEndpoint azure's own plan says it will
// have; while that is known only after azure applies, dns's plan names azure
// under its unresolved inputs, and dns applies once azure has.
export const azure = memberOutputsComponent("azure");

// The aws member, a Pulumi program on plunge (behold#1000), the same way: its
// one step reads the stack's outputs with `plunge stack output --json
// --show-secrets=false` (planned ones from `plunge preview --json`) and never
// applies it. While aws's preview still has changes the step refuses, so dns
// never applies against an awsEndpoint from before aws's own change.
export const aws = memberOutputsComponent("aws");

// The dns member as one component, applied after the three sites: its
// parameters are the endpoints they publish. azureEndpoint and awsEndpoint
// are wired from the two components above. gcpEndpoint is still read from
// what is applied by the Build step (scripts/front-door.ts build-dns), which
// also points each health check at the emulator that answers for it and
// writes the template cfn-deploy applies as the stack named after the
// environment.
export const records: Component = {
  name: "records",
  archetype: "infra",
  dependsOn: ["azure", "aws"],
  deploy: [
    phase("Build", [{ kind: "shell", cmd: "npx tsx ../scripts/front-door.ts build-dns", reason: "the checks probe emulator addresses that only exist on this machine" }]),
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "local",
        template: "dist/dns.json",
        inputs: { azureEndpoint: stackOutput("azure", "azureEndpoint"), awsEndpoint: stackOutput("aws", "awsEndpoint") },
      },
    ]),
  ],
};
