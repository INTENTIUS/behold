import { phase, type Component } from "@intentius/chant/components";

// The dns member as one component, applied after the three sites: its
// parameters are the endpoints they publish. The step is the emulator apply in
// scripts/front-door.ts, which reads those endpoints from what is applied and
// points each health check at the emulator that answers for it.
export const records: Component = {
  name: "records",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Apply", [{ kind: "shell", cmd: "npx tsx ../scripts/front-door.ts apply-dns", reason: "the checks probe emulator addresses that only exist on this machine" }]),
  ],
};
