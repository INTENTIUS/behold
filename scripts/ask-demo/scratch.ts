/**
 * behold#1161: what the ask demo's recorder boots, named once. Every name is
 * `behold-*` and every port is off the shared emulators' (src/scratch.ts);
 * src/scratch.test.ts holds the recorder to these and to nothing else.
 */
export const ASK_DEMO_SCRATCH = {
  floci: { name: "behold-ask-demo-floci", port: 4671 },
  flociAz: { name: "behold-ask-demo-floci-az", port: 4672 },
  flociGcp: { name: "behold-ask-demo-floci-gcp", port: 4673 },
  /** The kind cluster; kind names its node container `<name>-control-plane`. */
  cluster: { name: "behold-ask-demo" },
  /** `behold serve` of the copy. */
  serve: { port: 4674 },
} as const;

/** The emulator containers, in the order scripts/emulators-up.sh boots them. */
export const ASK_DEMO_CONTAINERS = [ASK_DEMO_SCRATCH.floci, ASK_DEMO_SCRATCH.flociAz, ASK_DEMO_SCRATCH.flociGcp] as const;

/** kind's context name for the cluster. */
export const ASK_DEMO_CONTEXT = `kind-${ASK_DEMO_SCRATCH.cluster.name}`;
