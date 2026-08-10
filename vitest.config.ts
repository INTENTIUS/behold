import { defineConfig } from "vitest/config";
// web/ is plain browser ESM (tsconfig excludes it), but web/layout-store.js is
// pure logic with no DOM in it — #228's delta store — so it gets real unit
// tests next to it rather than only smoke coverage.
export default defineConfig({ test: { include: ["src/**/*.test.ts", "web/**/*.test.js"] } });
