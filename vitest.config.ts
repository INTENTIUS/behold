import { defineConfig } from "vitest/config";
// web/ is plain browser ESM (tsconfig excludes it), but web/layout-store.js is
// pure logic with no DOM in it — #228's delta store — so it gets real unit
// tests next to it rather than only smoke coverage.
//
// The json reporter writes .vitest-last.json (gitignored) beside the default
// terminal output on EVERY run — the capture #334 asked for: the one-shot
// first-run-after-install failure has now lost its file's identity three
// times to terminal truncation, so the durable log runs always, not only
// when someone remembers to redirect. On the next occurrence,
// `jq '.testResults[] | select(.status != \"passed\") | .name' .vitest-last.json`
// names the file.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "web/**/*.test.js"],
    reporters: ["default", ["json", { outputFile: ".vitest-last.json" }]],
    // #334: the route tests that spawn a real chant (`carve status` over a
    // project, a lexicon read) have a fixed cost the runner sets — under a
    // second here, 4.7 s on a GitHub runner, 5.008 s the day PR #405 failed
    // its first run against the 5 s default. A spawn is not a unit test's
    // budget. Twenty seconds still catches a hang; it stops a slow runner
    // counting as a flake.
    testTimeout: 20_000,
  },
});
