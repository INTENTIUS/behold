/**
 * behold CLI. One verb today: `serve` — start the read-only control plane over a
 * chant project. Agent-drivable: the same read API the SPA uses is plain JSON, and
 * behold leans on chant's MCP for the underlying graph/lifecycle data (see README).
 */
import { resolve, dirname } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.ts";
import { runExport } from "./export.ts";
import { isAutoSyncMode, type AutoSyncMode } from "./autosync.ts";

const USAGE = `behold — a live control plane on chant (read-only core)

Usage:
  behold preview [loom-dir] [--port <n>]
  behold export [project-dir] [--out <dir>] [--env <name>] [--name <worker>]
  behold serve <project-dir…> [--port <n>] [--env <name>] [--poll <secs>]

  export  Capture the live estate into a self-contained, interactive STATIC
          bundle (default ./behold-export) — every env/tier × zoom × radial,
          replayable with no backend. Host it anywhere (Cloudflare Pages/Workers,
          any static server). Read-only: no live observe, no deploy. Defaults the
          project to Loom (like preview); pass a dir + --env for your own estate.
          Bring the estate up first (e.g. behold preview, or your creds/env) so
          the snapshot reflects live state.


  preview A turnkey, self-contained preview of Loom on the local Floci emulator
          (v0.1.0). Boots the emulator, deploys Loom, and serves the read +
          local-deploy experience — no real cloud, no git/PR ops, no opening
          your own infra. Defaults the Loom project to $BEHOLD_LOOM_DIR or the
          sibling ../loomster; pass a path to override. Needs Docker.

  serve   Start the server: the mixed-substrate graph of <project-dir> in a
          browser, coloured by drift. Read-only — never mutates. Pass several
          project dirs to compose them into one estate (#31): per-project
          boundary boxes + cross-stack edges. The first is the primary (ops,
          overlay, and rollback act on it).

Options:
  --port <n>          Port (default 4600).
  --env <name>        Environment name — turns on the live drift overlay.
  --poll <secs>       Re-query live drift every <secs> and push updates (needs --env).
  --auto-sync <mode>  On a polled drift, trigger a committed Op (needs --env + --poll).
                      off (default) | apply (heal via ApplyOp) | pull-request
                      (adopt via ReconcileOp). Gated applies still wait for Approve.
  --local             Boot the project's local emulator(s) (chant #920) and observe
                      them — the creds-free first apply. Deploys (Run/Sync) hit the
                      emulator; torn down on exit. Needs Docker.
  -h, --help          This text.
`;

export async function run(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === "preview") {
    await runPreview(rest);
    return;
  }

  if (cmd === "export") {
    await runExportCmd(rest);
    return;
  }

  if (cmd !== "serve") {
    process.stderr.write(`behold: unknown command '${cmd}'\n\n${USAGE}`);
    process.exit(2);
  }

  const projectDirs: string[] = [];
  let port = 4600;
  let env: string | undefined;
  let pollSecs: number | undefined;
  let autoSync: AutoSyncMode = "off";
  let local = false;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--port") port = Number(rest[++i]);
    else if (a === "--env") env = rest[++i];
    else if (a === "--poll") pollSecs = Number(rest[++i]);
    else if (a === "--local") local = true;
    else if (a === "--auto-sync") {
      const m = rest[++i];
      if (!m || !isAutoSyncMode(m)) {
        process.stderr.write("behold serve: --auto-sync must be off | apply | pull-request\n");
        process.exit(2);
      }
      autoSync = m;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      return;
    } else if (!a.startsWith("-")) projectDirs.push(a); // one or more project dirs (#31)
    else {
      process.stderr.write(`behold: unexpected argument '${a}'\n`);
      process.exit(2);
    }
  }

  if (projectDirs.length === 0) {
    process.stderr.write("behold serve: missing <project-dir>\n\n" + USAGE);
    process.exit(2);
  }
  if (!Number.isFinite(port)) {
    process.stderr.write("behold serve: --port must be a number\n");
    process.exit(2);
  }
  if (pollSecs !== undefined && (!Number.isFinite(pollSecs) || pollSecs <= 0)) {
    process.stderr.write("behold serve: --poll must be a positive number of seconds\n");
    process.exit(2);
  }
  if (pollSecs !== undefined && !env) {
    process.stderr.write("behold serve: --poll needs --env (it polls the live overlay)\n");
    process.exit(2);
  }
  if (autoSync !== "off" && (!env || pollSecs === undefined)) {
    process.stderr.write("behold serve: --auto-sync needs --env and --poll (it acts on polled drift)\n");
    process.exit(2);
  }

  const dirs = projectDirs.map((d) => resolve(d));
  await startServer({
    projectDir: dirs[0], // primary — ops/overlay/rollback act on it
    ...(dirs.length > 1 ? { projectDirs: dirs } : {}),
    port,
    ...(env ? { env } : {}),
    ...(pollSecs !== undefined ? { pollSecs } : {}),
    ...(autoSync !== "off" ? { autoSync } : {}),
    ...(local ? { local: true } : {}),
  });
}

/** `behold preview` — turnkey Loom-on-Floci preview (v0.1.0). Resolves the Loom
 * project (arg → $BEHOLD_LOOM_DIR → sibling ../loomster), then serves it with the
 * local emulator booted and previewMode on (git/PR ops hidden + gated, substrate
 * strip scoped to Docker+Floci, no arbitrary-project switching). */
async function runPreview(rest: string[]): Promise<void> {
  let port = 4600;
  let dirArg: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--port") port = Number(rest[++i]);
    else if (a === "-h" || a === "--help") return void process.stdout.write(USAGE);
    else if (!a.startsWith("-")) dirArg = a;
  }
  if (!Number.isFinite(port)) {
    process.stderr.write("behold preview: --port must be a number\n");
    process.exit(2);
  }
  const beholdRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const loomDir = resolve(dirArg ?? process.env.BEHOLD_LOOM_DIR ?? resolve(beholdRoot, "..", "loomster"));
  if (!existsSync(loomDir)) {
    process.stderr.write(
      `behold preview: Loom project not found at ${loomDir}\n` +
        "Pass a path (`behold preview <loom-dir>`) or set BEHOLD_LOOM_DIR.\n",
    );
    process.exit(2);
  }
  // Turnkey env for Loom-on-Floci, without clobbering anything already exported.
  // LOOM_ENV selects Loom's local (emulator) environment; AWS_ENDPOINT_URL points
  // at Loom's Floci on :4566; the AWS SDK still needs *some* creds present (Floci
  // ignores their value). We deliberately DON'T use `--local` (chant's `emulator
  // up` boots a different `chant-floci`/`floci:latest` that clashes on :4566 with
  // Loom's own `floci`/agentcore container) — the substrate strip's Floci "Bring
  // up" runs Loom's `scripts/local/local-up.sh`, which boots Floci AND deploys.
  process.env.LOOM_ENV ??= "local";
  process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";
  process.env.AWS_ACCESS_KEY_ID ??= "test";
  process.env.AWS_SECRET_ACCESS_KEY ??= "test";
  process.env.AWS_REGION ??= "us-east-1";
  process.stdout.write(
    `behold preview — Loom on the local Floci emulator (read + local deploy only)\n  project: ${loomDir}\n` +
      `  If Floci isn't up yet, use "Bring up" on the Floci substrate pill (boots + deploys Loom).\n`,
  );
  await startServer({ projectDir: loomDir, port, env: "local", previewMode: true });
}

/** `behold export` — capture the estate into a static interactive bundle.
 * Defaults the project to Loom (like `preview`, with turnkey local env); pass a
 * dir + `--env` to export your own estate (bring it up / set creds first). */
async function runExportCmd(rest: string[]): Promise<void> {
  let outDir = resolve("behold-export");
  let env: string | undefined;
  let name: string | undefined;
  let dirArg: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") outDir = resolve(rest[++i]);
    else if (a === "--env") env = rest[++i];
    else if (a === "--name") name = rest[++i];
    else if (a === "-h" || a === "--help") return void process.stdout.write(USAGE);
    else if (!a.startsWith("-")) dirArg = a;
  }

  let projectDir: string;
  if (dirArg) {
    projectDir = resolve(dirArg);
  } else {
    // No project given → export Loom, same resolution + turnkey local env as `preview`.
    const beholdRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    projectDir = resolve(process.env.BEHOLD_LOOM_DIR ?? resolve(beholdRoot, "..", "loomster"));
    process.env.LOOM_ENV ??= env ?? "local";
    process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";
    process.env.AWS_ACCESS_KEY_ID ??= "test";
    process.env.AWS_SECRET_ACCESS_KEY ??= "test";
    process.env.AWS_REGION ??= "us-east-1";
    env ??= "local";
  }
  if (!existsSync(projectDir)) {
    process.stderr.write(`behold export: project not found at ${projectDir}\n`);
    process.exit(2);
  }
  await runExport({ projectDir, port: 0, ...(env ? { env } : {}) }, outDir, name ? { name } : {});
}

// Run when invoked directly (`tsx src/cli.ts …`), not when imported. realpath both
// sides: through a symlinked path tsx sets import.meta.url to the realpath while
// argv[1] keeps the symlink, so a raw string compare silently skips run().
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMainModule()) {
  run(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`behold: fatal: ${err?.message ?? err}\n`);
    process.exit(3);
  });
}
