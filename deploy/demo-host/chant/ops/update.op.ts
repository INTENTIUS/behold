import { Op, phase, shell } from "@intentius/chant/op";
import { waitBootstrapped } from "./remote";

/**
 * Moves the host to new refs. The refs come from the environment,
 * TERRAGUCCI_REF and BEHOLD_REF; one left unset keeps what demo.env names, and
 * with neither the checkouts move to demo.env's refs (after a fix lands on main):
 *
 *   TERRAGUCCI_REF=v1.2.3 BEHOLD_REF=behold-v0.30.0 npx chant run demo-host-update
 *
 * Prepare moves the behold checkout and builds the behold and driver images
 * while the loop and the site carry on. Update waits on the host for a quiet
 * step (demo.json says reset or applied, INTENTIUS/terragucci#1014; at most
 * DEMO_QUIET_WAIT seconds, 900), stops the driver, moves the terragucci
 * checkout and starts it again. Bootstrapped waits until the driver's `up` at
 * the new commit is done and the loop runs again.
 */
export default Op({
  name: "demo-host-update",
  overview: "Build the behold and driver images while the loop runs, move terragucci at a quiet step (reset or applied), and wait for the driver's bootstrap at the new commit.",
  labels: { Host: "demo-host" },
  phases: [
    phase("Prepare", [shell("bash ops/host.sh update-prepare", { timeout: "30m" })]),
    phase("Update", [shell("bash ops/host.sh update", { timeout: "25m" })]),
    phase("Bootstrapped", [shell(waitBootstrapped, { timeout: "35m" })]),
  ],
});
