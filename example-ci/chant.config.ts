import type { ChantConfig } from "@intentius/chant";

export default {
  lexicons: ["aws", "github"],
  sourceDir: "src",
  environments: ["prod", "staging"],
} satisfies ChantConfig;
