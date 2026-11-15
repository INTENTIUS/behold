#!/usr/bin/env node
/**
 * behold-graph bin launcher. Checked into git so it exists when npm validates
 * the package before the build runs. It loads the built dist/cli.js.
 */
import(new URL("../dist/cli.js", import.meta.url).href)
  .then((mod) => mod.main(process.argv.slice(2)))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`behold-graph: fatal: ${err?.message ?? err}\n`);
    process.exit(3);
  });
