import { Op, gate, phase, shell } from "@intentius/chant/op";
import { demoHost, waitBootstrapped, waitQuiet } from "./remote";

/** The public name, as demo.env names it. */
const NAME = "${DEMO_HOSTNAME:-demo.intentius.io}";

/**
 * Launch morning (2026-11-04). Checks the name, drops the plain-http view by
 * the instance's address by applying what behold's main holds (behold #590
 * removes it from the Caddyfile), stops at a gate, and only after an approval
 * takes the password off (`demo-host.sh open`).
 *
 *   npx chant run demo-host-go-public
 *   npx chant approve demo-host-go-public take-the-password-off --actor <you>
 *   npx chant run demo-host-go-public
 *
 * Every step before the gate can run again: the update happens only while the
 * host's Caddyfile still has the by-address site, so the run after the
 * approval passes through it without restarting anything.
 */
export default Op({
  name: "demo-host-go-public",
  overview: "Check demo.intentius.io resolves to the Elastic IP and serves https, drop the by-address http site, then after an approval take the password off and check the site answers without one.",
  labels: { Host: "demo-host" },
  phases: [
    phase("Name", [
      shell(`ip="$(bash ops/host.sh ip)"; got="$(dig +short A "${NAME}" | tail -1)"
[ "$got" = "$ip" ] || { echo "${NAME} resolves to '$got', not the Elastic IP $ip" >&2; exit 1; }
echo "${NAME} -> $ip"`),
      // 401 while the password is on, 200 once it is off; anything else, or
      // no certificate, fails.
      shell(`code="$(curl -sS -o /dev/null -w '%{http_code}' -m 20 "https://${NAME}/")"
case "$code" in 200|401) echo "https://${NAME}/ answers $code" ;; *) echo "https://${NAME}/ answers $code" >&2; exit 1 ;; esac`),
    ]),
    phase("Drop the address site", [
      shell(`if ! bash ops/host.sh ip-site; then echo "the host's Caddyfile has no by-address site"; exit 0; fi
(${waitQuiet}) || exit 1
bash ops/host.sh update
(${waitBootstrapped}) || exit 1
if bash ops/host.sh ip-site; then
  echo "behold's main still has the plain-http site in the Caddyfile (behold #590 not merged); nothing changed on the site" >&2
  exit 1
fi`, { timeout: "3h" }),
      shell(demoHost("reload-caddy")),
      shell(`ip="$(bash ops/host.sh ip)"; code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "http://$ip/" || true)"
[ "$code" != 401 ] && [ "$code" != 200 ] || { echo "http://$ip/ still serves the view ($code)" >&2; exit 1; }
echo "http://$ip/ no longer serves the view ($code)"`),
    ]),
    phase("Approve", [
      gate("take-the-password-off", {
        timeout: "72h",
        description: "Takes the password off: from here on anyone can read the demo. Approve on launch morning.",
      }),
    ]),
    phase("Open", [shell(demoHost("open"))]),
    phase("Check", [
      shell(`code="$(curl -sS -o /dev/null -w '%{http_code}' -m 20 "https://${NAME}/")"
[ "$code" = 200 ] || { echo "https://${NAME}/ answers $code without a password" >&2; exit 1; }
echo "https://${NAME}/ answers 200 without a password"`),
    ]),
  ],
});
