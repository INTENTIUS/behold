import { Op, phase, build, awsApply, httpCheck } from "@intentius/chant-lexicon-temporal";

// Deploy the S3 bucket to the local Floci emulator via the CloudFormation API
// (awsApply — direct create-or-update + poll, no aws CLI, honours the endpoint).
// `behold serve … --local` boots Floci; this Op's Run button deploys to it. No
// cloud account, no creds — the creds-free first apply. (The `prod-apply` ApplyOp
// is the real-AWS path; it shells `aws cloudformation deploy`.)
export default Op({
  name: "floci-apply",
  overview: "S3 bucket → local Floci (CloudFormation API), no cloud account",
  taskQueue: "behold-local",
  phases: [
    phase("Build", [build(".", { script: "build" })]),
    phase("Apply", [awsApply("template.json", { stackName: "behold-local", endpoint: "http://localhost:4566" })]),
    phase("Verify", [httpCheck("http://localhost:4566/behold-floci-demo")]),
  ],
});
