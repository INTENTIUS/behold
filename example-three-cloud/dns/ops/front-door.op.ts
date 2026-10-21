import { Op, phase, shell } from "@intentius/chant/op";

// The front door's page, rebuilt from nothing on the floci emulators that
// `behold demo three-cloud` boots: apply the four members, turn Azure off,
// wait until Route 53's check on it fails, and export the page. Each phase is
// one step of ../../scripts/front-door.ts, which says what it does and why.
//
//   chant run front-door          (from this directory)
//   npm run front-door            (from the workspace root, the same steps without chant)
//
// The aws member does not apply on floci yet (lex00/floci#261): the Apply
// phase says so and carries on, and the page shows AWS failing its check too.
const step = (args: string) => shell(`cd .. && ./node_modules/.bin/tsx scripts/front-door.ts ${args}`, { timeout: "15m" });

export default Op({
  name: "front-door",
  overview: "Apply dns, aws, azure and gcp to the emulators, turn Azure off, wait for its health check to fail, export the page to ../export",
  phases: [
    phase("Apply", [step("apply")]),
    phase("Turn Azure off", [step("azure-off")]),
    phase("Wait for Route 53", [step("wait")]),
    phase("Export", [step("export --out export")]),
  ],
});
