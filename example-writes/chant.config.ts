import type { TemporalChantConfig } from "@intentius/chant-lexicon-temporal";

export default {
  lexicons: ["aws", "temporal"],
  sourceDir: "src",
  environments: ["prod"],
  ownership: { stack: "behold-writes", env: "prod" },
  temporal: {
    profiles: { prod: { address: "localhost:7233", namespace: "default", taskQueue: "behold-writes", autoStart: true } },
    defaultProfile: "prod",
  } satisfies TemporalChantConfig,
};
