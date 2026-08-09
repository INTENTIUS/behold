/**
 * behold CLI. One verb today: `serve` — start the read-only control plane over a
 * chant project. Agent-drivable: the same read API the SPA uses is plain JSON, and
 * behold leans on chant's MCP for the underlying graph/lifecycle data (see README).
 */
import { resolve, dirname, join, relative, sep } from "node:path";
import { realpathSync, existsSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer, beholdVersion } from "./server.ts";
import { runExport } from "./export.ts";
import { isAutoSyncMode, type AutoSyncMode } from "./autosync.ts";

const USAGE = `behold — a live control plane on chant (read-only core)

Usage:
  behold demo [target-dir] [--port <n>]
  behold preview [project-dir] [--port <n>] [--emulator]
  behold export [project-dir] [--out <dir>] [--env <name>] [--name <worker>] [--emulator]
  behold serve <project-dir…> [--port <n>] [--env <name>] [--poll <secs>] [--local]

  demo    The five-minute path from npm — no chant project needed. Copies the
          bundled example (an S3 bucket + policy) into ./behold-demo (or
          [target-dir]), installs its dependencies, and serves it against a
          local emulator: blue = declared, click Deploy, watch it turn green.
          Needs Docker. The copy is yours — edit its source and watch the
          graph change live.

  export  Capture the live estate into a self-contained, interactive STATIC
          bundle (default ./behold-export) — every env/tier × zoom × radial,
          replayable with no backend. Host it anywhere (Cloudflare Pages/Workers,
          any static server). Read-only: no live observe, no deploy. Defaults the
          project to the current directory; pass a dir for someone else's, and
          --env for that project's live overlay. Bring the estate up first (e.g.
          behold preview, or your creds/env) so the snapshot reflects live state.

  preview Serve one project's graph in a browser at a single port — the quick
          way to look at a chant project. Defaults the project to the current
          directory; pass a path to look at another one.

  serve   Start the server: the mixed-substrate graph of <project-dir> in a
          browser, coloured by drift. Read-only — never mutates. Pass several
          project dirs to compose them into one estate (#31): per-project
          boundary boxes + cross-stack edges. The first is the primary (ops,
          overlay, and rollback act on it).

Options:
  --port <n>          Port (default 4600). preview/serve.
  --env <name>        Environment name — turns on the live drift overlay.
                      export/serve.
  --poll <secs>       Re-query live drift every <secs> and push updates (needs --env).
                      serve only.
  --auto-sync <mode>  On a polled drift, trigger a committed Op (needs --env + --poll).
                      off (default) | apply (heal via ApplyOp) | pull-request
                      (adopt via ReconcileOp). Gated applies still wait for Approve.
                      Routes per substrate (#117): the substrate that drifted
                      picks the Op declaring that target, and declines out loud
                      rather than guessing when several match or none does.
                      serve only.
  --local             serve only: boot the *served project's own* local
                      emulator(s) via chant (\`chant emulator up\`, chant #920)
                      and observe them — the creds-free first apply. Deploys
                      (Run/Sync) hit the emulator; torn down on exit. Needs
                      Docker. Generic — works for any emulator-backed lexicon,
                      not Loom-specific. Not the same thing as --emulator below.
  --emulator          preview/export only: turnkey Loom-on-Floci demo (v0.1.0).
                      Injects the env Loom's own Floci setup expects
                      (AWS_ENDPOINT_URL=http://localhost:4566, dummy AWS creds,
                      LOOM_ENV=local) and, for preview, locks the UI into
                      previewMode (git/PR ops hidden, substrate strip scoped to
                      Docker+Floci). Off by default — without it, preview/export
                      just read the given project's declared source graph (plus
                      --env's live overlay, for export). Reproduces the old
                      default behavior on request: \`behold preview ../loomster
                      --emulator\`. Needs Docker. Hardcoded to Loom's env-var
                      names, unlike --local; kept separate because Loom's own
                      \`scripts/local/local-up.sh\` Floci setup clashes on :4566
                      with chant's generic \`chant emulator up\`.
  --out <dir>         export only: output directory (default ./behold-export).
  --name <worker>     export only: Cloudflare Worker name in the generated
                      wrangler.jsonc.
  -h, --help          This text.
  -v, --version       Print the behold version.
`;

export async function run(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === "-v" || cmd === "--version") {
    process.stdout.write(beholdVersion() + "\n");
    return;
  }

  if (cmd === "demo") {
    await runDemo(rest);
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
  for (const d of dirs) warnIfNotChantProject(d);
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

/** #193: point out a not-a-chant-project directory at startup, in the same
 * breath as the URL — the server's /api/graph 404s with the structured
 * no-project card, and this is the terminal-side half of the same honesty.
 * A warning, not an exit: serving anyway is right (the card explains, and
 * the directory may be about to become a project). */
function warnIfNotChantProject(dir: string): void {
  if (existsSync(join(dir, "chant.config.ts"))) return;
  process.stderr.write(
    `behold: warning — ${dir} has no chant.config.ts; this doesn't look like a chant project.\n` +
      `        No project yet? \`behold demo\` serves a bundled working example (needs Docker).\n`,
  );
}

/** `behold demo` (#193) — the five-minute path for someone who just ran
 * `npm install @intentius/behold` and has no chant project: copy the bundled
 * example-writes into a directory THEY own (so editing its source and
 * watching the graph react is part of the demo), install its deps, and serve
 * it exactly the way the repo's own `npm run demo` does — `serve <dir>
 * --local --env prod`. Idempotent: an existing target is reused (and an
 * already-installed one skips npm install), so a second `behold demo` is
 * just "start the demo again". */
async function runDemo(rest: string[]): Promise<void> {
  let port = 4600;
  let dirArg: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--port") port = Number(rest[++i]);
    else if (a === "-h" || a === "--help") return void process.stdout.write(USAGE);
    else if (!a.startsWith("-")) dirArg = a;
    else {
      process.stderr.write(`behold demo: unexpected argument '${a}'\n`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(port)) {
    process.stderr.write("behold demo: --port must be a number\n");
    process.exit(2);
  }
  // The bundled example ships in the npm package (package.json `files`),
  // beside dist/ — same relative resolution as beholdVersion()'s.
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", "example-writes");
  if (!existsSync(bundled)) {
    process.stderr.write("behold demo: this install has no bundled example project (example-writes)\n");
    process.exit(2);
  }
  const target = resolve(dirArg ?? "behold-demo");
  if (!existsSync(target)) {
    process.stdout.write(`behold demo → copying the example project to ${target} (it's yours — edit it)\n`);
    // Skip only node_modules INSIDE the example. The filter must test the
    // path relative to the bundled root: in an npm install the example
    // itself lives under node_modules/@intentius/behold/, so a bare
    // `src.includes("node_modules")` matched every file and copied nothing.
    cpSync(bundled, target, {
      recursive: true,
      filter: (src) => !relative(bundled, src).split(sep).includes("node_modules"),
    });
  } else {
    process.stdout.write(`behold demo → reusing ${target}\n`);
  }
  if (!existsSync(join(target, "node_modules"))) {
    process.stdout.write("behold demo → npm install (the example's own chant + lexicons)…\n");
    const r = spawnSync("npm", ["install"], { cwd: target, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) {
      process.stderr.write(`behold demo: npm install failed in ${target}${r.error ? ` (${r.error.message})` : ""}\n`);
      process.exit(r.status ?? 1);
    }
  }
  process.stdout.write("behold demo → serving with a local emulator (Docker). Blue = declared; Deploy turns it green.\n");
  await run(["serve", target, "--local", "--env", "prod", "--port", String(port)]);
}

/** Turnkey Loom-on-Floci env (#69): the AWS SDK creds Floci ignores the value of,
 * plus the endpoint + LOOM_ENV that Loom's own `chant.config.ts` and `scripts/
 * local/local-up.sh` expect. Hardcoded to Loom's env-var names — this is the
 * explicit `--emulator` demo path, not a generic emulator mechanism (that's
 * `serve --local`, chant #920's `chant emulator up`). Never clobbers anything
 * already exported. */
function injectEmulatorEnv(env: string | undefined): void {
  process.env.LOOM_ENV ??= env ?? "local";
  process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";
  process.env.AWS_ACCESS_KEY_ID ??= "test";
  process.env.AWS_SECRET_ACCESS_KEY ??= "test";
  process.env.AWS_REGION ??= "us-east-1";
}

/** `behold preview` — serve one project's graph in a browser (default: cwd; pass
 * a path for another project). Plain by default: no env, no emulator, just the
 * declared source graph on one port. `--emulator` turns it into the turnkey
 * Loom-on-Floci demo (v0.1.0): injects the Floci env and locks the UI into
 * previewMode (git/PR ops hidden + gated, substrate strip scoped to
 * Docker+Floci, no arbitrary-project switching). */
async function runPreview(rest: string[]): Promise<void> {
  let port = 4600;
  let dirArg: string | undefined;
  let emulator = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--port") port = Number(rest[++i]);
    else if (a === "--emulator") emulator = true;
    else if (a === "-h" || a === "--help") return void process.stdout.write(USAGE);
    else if (!a.startsWith("-")) dirArg = a;
  }
  if (!Number.isFinite(port)) {
    process.stderr.write("behold preview: --port must be a number\n");
    process.exit(2);
  }
  const projectDir = resolve(dirArg ?? process.cwd());
  if (!existsSync(projectDir)) {
    process.stderr.write(`behold preview: project not found at ${projectDir}\n`);
    process.exit(2);
  }
  if (!emulator) {
    warnIfNotChantProject(projectDir);
    await startServer({ projectDir, port });
    return;
  }
  injectEmulatorEnv("local");
  process.stdout.write(
    `behold preview --emulator — Loom on the local Floci emulator (read + local deploy only)\n  project: ${projectDir}\n` +
      `  If Floci isn't up yet, use "Bring up" on the Floci substrate pill (boots + deploys Loom).\n`,
  );
  await startServer({ projectDir, port, env: "local", previewMode: true });
}

/** `behold export` — capture the estate into a static interactive bundle.
 * Defaults the project to cwd (pass a dir + `--env` to export another estate;
 * bring it up / set creds first). `--emulator` injects the same turnkey
 * Loom-on-Floci env as `preview --emulator`, for exporting that demo. */
async function runExportCmd(rest: string[]): Promise<void> {
  let outDir = resolve("behold-export");
  let env: string | undefined;
  let name: string | undefined;
  let dirArg: string | undefined;
  let emulator = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") outDir = resolve(rest[++i]);
    else if (a === "--env") env = rest[++i];
    else if (a === "--name") name = rest[++i];
    else if (a === "--emulator") emulator = true;
    else if (a === "-h" || a === "--help") return void process.stdout.write(USAGE);
    else if (!a.startsWith("-")) dirArg = a;
  }

  const projectDir = resolve(dirArg ?? process.cwd());
  if (emulator) {
    injectEmulatorEnv(env);
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
