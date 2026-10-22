import { phase, type Component } from "@intentius/chant/components";

// The gcp member as one component. The lexicon has no component deploy step
// yet (chant#4273), so the step is the emulator apply in scripts/front-door.ts.
export const site: Component = {
  name: "site",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Apply", [{ kind: "shell", cmd: "npx tsx ../scripts/front-door.ts apply-gcp", reason: "no gcp component deploy step yet (chant#4273)" }]),
  ],
};
