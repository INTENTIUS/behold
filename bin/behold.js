#!/usr/bin/env node
/**
 * behold bin launcher.
 *
 * Checked into git so it exists at npm pack-validation time (before `prepack` /
 * `build` runs). It loads the built dist/cli.js and calls the exported `run()`
 * with the process argv.
 */

import(new URL("../dist/cli.js", import.meta.url).href)
  .then((mod) => mod.run(process.argv.slice(2)))
  .catch((err) => {
    process.stderr.write(`behold: fatal: ${err?.message ?? err}\n`);
    process.exit(3);
  });
