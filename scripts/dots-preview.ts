// `npm run preview:dots` (#712): the dots preview on http://127.0.0.1:4712/,
// local only. It serves behold's own page over two committed sources, a carve
// recording (scripts/dot-bench/) and the terralith walkthrough's snapshots
// (src/__fixtures__/terralith), and reads nothing else: no chant, no account,
// no emulator. Read-only: it builds no Op runner.
//
//   http://127.0.0.1:4712/?dots=carve:carve-terralith-14   the 1,041-resource carve
//   http://127.0.0.1:4712/?dots=terralith                   the 23-resource walkthrough
//
// --port <n> picks another port.

import { serve } from "@hono/node-server";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server.ts";
import { ReadOnlyRunner } from "../src/public-mode.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const at = args.indexOf("--port");
const port = at >= 0 ? Number(args[at + 1]) : 4712;
const host = "127.0.0.1";

const app = createApp(
  {
    projectDir: join(root, "scripts", "dot-bench"),
    port,
    host,
    dotsPreview: { recordings: join(root, "scripts", "dot-bench"), walkthrough: join(root, "src", "__fixtures__", "terralith") },
  },
  undefined,
  undefined,
  new ReadOnlyRunner(),
);
serve({ fetch: app.fetch, port, hostname: host }, () => {
  process.stdout.write(`behold dots preview: http://${host}:${port}/?dots=carve:carve-terralith-14\n`);
  process.stdout.write(`  the walkthrough:   http://${host}:${port}/?dots=terralith\n`);
});
