import { Op, gate, phase, shell } from "@intentius/chant/op";

const plan = shell("bash ops/infra.sh plan", { id: "plan" });

/**
 * The host's AWS resources (src/aws) to the stack demo-intentius-host: build
 * template.json, make a change set and show it, stop at a gate, and after an
 * approval execute it and run drift detection.
 *
 *   npx chant run demo-host-infra
 *   npx chant approve demo-host-infra apply-change-set --actor <you>
 *   npx chant run demo-host-infra
 *
 * The gate approves the plan's digest: if the second run's change set differs
 * from the one approved, it stops again. A change set that would replace a
 * resource is refused before the gate.
 */
export default Op({
  name: "demo-host-infra",
  overview: "Build the demo host's CloudFormation template, show its change set, and after an approval execute it and check drift.",
  labels: { Host: "demo-host" },
  phases: [
    phase("Build", [shell("npm run build:aws")]),
    phase("Plan", [plan]),
    phase("Approve", [
      gate("apply-change-set", {
        plan: plan.out.stdout,
        description: "Executes the change set the Plan phase printed against the live demo host's stack.",
      }),
    ]),
    phase("Apply", [shell("bash ops/infra.sh apply", { timeout: "30m" })]),
    phase("Drift", [shell("bash ops/infra.sh drift", { timeout: "10m" })]),
  ],
});
