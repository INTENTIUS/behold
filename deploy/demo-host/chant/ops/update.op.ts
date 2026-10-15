import { Op, phase, shell } from "@intentius/chant/op";
import { waitBootstrapped, waitQuiet } from "./remote";

/**
 * Moves the host to new refs: `demo-host.sh update`, at a step where the loop
 * can be interrupted. The refs come from the environment, TERRAGUCCI_REF and
 * BEHOLD_REF; one left unset keeps what demo.env names, and with neither the
 * checkouts move to demo.env's refs (after a fix lands on main):
 *
 *   TERRAGUCCI_REF=v1.2.3 BEHOLD_REF=behold-v0.30.0 npx chant run demo-host-update
 */
export default Op({
  name: "demo-host-update",
  overview: "Wait for demo.json to say reset or applied, move the checkouts to the refs given, rebuild, and wait for the driver's bootstrap at the new terragucci commit.",
  labels: { Host: "demo-host" },
  phases: [
    phase("Quiet step", [shell(waitQuiet, { timeout: "35m" })]),
    phase("Update", [shell("bash ops/host.sh update", { timeout: "45m" })]),
    phase("Bootstrapped", [shell(waitBootstrapped, { timeout: "80m" })]),
  ],
});
