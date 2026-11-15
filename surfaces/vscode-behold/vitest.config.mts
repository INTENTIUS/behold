import { defineConfig } from "vitest/config";

// This folder is its own package: without a config here vitest finds the
// repository's, which includes src/** and not test/**.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
