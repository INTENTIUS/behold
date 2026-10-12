import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// #524: a SQL Yodeler project with a foreign key, which neither of
// sql-yodeler's examples has: orders REFERENCES customers.
export default {
  lexicons: ["sql"],
  sourceDir: "src",
  sql: { dialect: "postgres" },
} satisfies ChantConfig;
