// The ops' shared pieces: a command on the demo host, over ssh (host.sh),
// and demo-host.sh there. Every op runs from deploy/demo-host/chant on the
// operator's laptop: `npx chant run <name>`.

/** A command line run on the host as ubuntu. */
export const onHost = (cmd: string): string => `bash ops/host.sh run ${JSON.stringify(cmd)}`;

/** demo-host.sh from the host's behold checkout, as root. */
export const demoHost = (args: string): string =>
  onHost(`sudo /opt/demo/behold/deploy/demo-host/demo-host.sh ${args}`);

/**
 * Waits until demo.json's step is one the loop can be interrupted at, `reset`
 * or `applied`: no wave is waiting or applying (INTENTIUS/terragucci#1014).
 * Read from floci on the host. Gives up after DEMO_QUIET_WAIT seconds (1800).
 */
export const waitQuiet = `limit="\${DEMO_QUIET_WAIT:-1800}"; start=$(date +%s)
while :; do
  step="$(bash ops/host.sh step)"
  case "$step" in reset|applied) echo "demo.json says $step"; exit 0 ;; esac
  [ $(( $(date +%s) - start )) -lt "$limit" ] || { echo "demo.json still says $step after \${limit}s" >&2; exit 1; }
  echo "demo.json says $step; waiting for reset or applied" >&2
  sleep 20
done`;

/**
 * Waits until floci holds the driver's base for the terragucci checkout's
 * commit: the marker driver-entry.sh writes after `stack/demo.sh up`, when it
 * logs "bootstrapped at terragucci <commit>".
 */
export const waitBootstrapped = `want="$(bash ops/host.sh terragucci-head)"; limit="\${DEMO_BOOTSTRAP_WAIT:-4500}"; start=$(date +%s)
while :; do
  have="$(bash ops/host.sh bootstrapped)"
  [ "$have" = "$want" ] && { echo "bootstrapped at terragucci \${want:0:8}"; exit 0; }
  [ $(( $(date +%s) - start )) -lt "$limit" ] || { echo "no base for terragucci \${want:0:8} after \${limit}s (floci has '\${have:0:8}'); docker logs demo-host-driver on the host" >&2; exit 1; }
  echo "waiting for the driver's bootstrap at terragucci \${want:0:8} (floci has '\${have:0:8}')" >&2
  sleep 30
done`;
