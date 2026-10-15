import { Op, phase, shell } from "@intentius/chant/op";
import { demoHost, onHost, waitBootstrapped } from "./remote";

/**
 * A fresh instance to a running demo: `demo-host.sh bootstrap`, one piece per
 * phase. The secrets file (DEMO_SECRETS, default ./secrets.env, never in the
 * repo) holds DEMO_AUTH_PASSWORD and any key of demo.env.example. It is copied
 * to the host for the configure phase and removed there after it.
 *
 * Never run against the live host: it is for a new instance.
 */
export default Op({
  name: "demo-host-bootstrap",
  overview: "Bring a fresh demo host up: Docker, the checkouts, demo.env, the units, the images, the driver's base apply, then behold and Caddy.",
  labels: { Host: "demo-host" },
  phases: [
    phase("Machine", [
      shell("bash ops/host.sh copy ../demo-host.sh /home/ubuntu/demo-host.sh"),
      shell(`bash ops/host.sh copy "\${DEMO_SECRETS:-secrets.env}" /home/ubuntu/demo-host-secrets.env`),
      shell(onHost("sudo bash /home/ubuntu/demo-host.sh install"), { timeout: "30m" }),
    ]),
    phase("Behold checkout", [
      shell(onHost("sudo bash /home/ubuntu/demo-host.sh checkout-self --secrets /home/ubuntu/demo-host-secrets.env")),
    ]),
    phase("Configure", [
      shell(demoHost("configure --secrets /home/ubuntu/demo-host-secrets.env")),
      shell(onHost("rm -f /home/ubuntu/demo-host-secrets.env")),
    ]),
    phase("Checkouts", [shell(demoHost("checkouts"))]),
    phase("Units", [shell(demoHost("units"))]),
    phase("Images", [shell(demoHost("build"), { timeout: "45m" })]),
    phase("Driver", [shell(demoHost("start-driver"))]),
    // The first bootstrap builds terragucci's CI images and applies the base.
    phase("Base apply", [shell(waitBootstrapped, { timeout: "80m" })]),
    phase("Site", [shell(demoHost("up")), shell(demoHost("status"))]),
  ],
});
