#!/usr/bin/env node
/** Entry point of the action: `main.mjs read | report | post`. See run.mjs. */
import { join } from "node:path";
import { loadBehold, postComment, readChanged, readInputs, report } from "./run.mjs";

const phase = process.argv[2];
const env = process.env;
const inputs = readInputs(env);
const scratch = join(env.RUNNER_TEMP ?? ".", "behold-graph-install");

try {
  if (phase === "read") {
    const behold = await loadBehold({ module: inputs.module, version: inputs.version, scratch });
    await readChanged({ env, inputs, behold });
  } else if (phase === "report") {
    await report({ env, inputs });
  } else if (phase === "post") {
    await postComment({ env, inputs });
  } else {
    throw new Error(`unknown phase ${phase}; expected read, report or post`);
  }
} catch (err) {
  process.stderr.write(`::error::behold: ${err.message}\n`);
  process.exit(1);
}
