import { Op, phase, build, httpCheck } from "@intentius/chant/op";
import { awsApply } from "@intentius/chant-lexicon-aws";

// Deploy the S3 bucket to the local Floci emulator via the CloudFormation API
// (awsApply — direct create-or-update + poll, no aws CLI, honours the endpoint).
// `behold serve … --local` boots Floci; this Op's Run button deploys to it. No
// cloud account, no creds — the creds-free first apply. (prod-apply is the
// real-AWS path; it shells the aws CLI.)
export default Op({
  name: "floci-apply",
  overview: "S3 bucket → local Floci (CloudFormation API), no cloud account",
  phases: [
    phase("Build", [build(".", { script: "build" })]),
    // Stack name = the env ("prod"), so `serve --local --env prod`'s overlay —
    // which queries the CFN stack named after the env — observes this deploy and
    // flips the node green (chant #926 points the live query at the emulator).
    phase("Apply", [awsApply("template.json", { stackName: "prod", endpoint: "http://localhost:4566" })]),
    phase("Verify", [httpCheck("http://localhost:4566/behold-floci-demo")]),
  ],
});
