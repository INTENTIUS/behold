import type { ChantConfig } from "@intentius/chant";

// A single-lexicon AWS project with one environment. `environments` lets
// `chant graph --live --env prod` run (behold's /api/overlay); `ownership`
// marks resources so the live query scopes to chant-managed ones.
export default {
  lexicons: ["aws"],
  environments: ["prod"],
  ownership: { stack: "behold-example", env: "prod" },
} satisfies ChantConfig;
