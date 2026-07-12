/**
 * behold CLI. One verb today: `serve` — start the read-only control plane over a
 * chant project. Agent-drivable: the same read API the SPA uses is plain JSON, and
 * behold leans on chant's MCP for the underlying graph/lifecycle data (see README).
 */
import { resolve } from "node:path";
import { startServer } from "./server.ts";

const USAGE = `behold — a live control plane on chant (read-only core)

Usage:
  behold serve <project-dir> [--port <n>] [--env <name>]

  serve   Start the server: the mixed-substrate graph of <project-dir> in a
          browser, coloured by drift. Read-only — never mutates.

Options:
  --port <n>     Port (default 4600).
  --env <name>   Environment name (for the live/overlay path; pending chant #821).
  -h, --help     This text.
`;

export async function run(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd !== "serve") {
    process.stderr.write(`behold: unknown command '${cmd}'\n\n${USAGE}`);
    process.exit(2);
  }

  let projectDir: string | undefined;
  let port = 4600;
  let env: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--port") port = Number(rest[++i]);
    else if (a === "--env") env = rest[++i];
    else if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      return;
    } else if (!a.startsWith("-") && projectDir === undefined) projectDir = a;
    else {
      process.stderr.write(`behold: unexpected argument '${a}'\n`);
      process.exit(2);
    }
  }

  if (projectDir === undefined) {
    process.stderr.write("behold serve: missing <project-dir>\n\n" + USAGE);
    process.exit(2);
  }
  if (!Number.isFinite(port)) {
    process.stderr.write("behold serve: --port must be a number\n");
    process.exit(2);
  }

  startServer({ projectDir: resolve(projectDir), port, ...(env ? { env } : {}) });
}

// Allow `tsx src/cli.ts ...` in dev.
if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`behold: fatal: ${err?.message ?? err}\n`);
    process.exit(3);
  });
}
