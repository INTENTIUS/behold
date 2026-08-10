/**
 * behold CLI. One verb today: `serve` — start the read-only control plane over a
 * chant project. Agent-drivable: the same read API the SPA uses is plain JSON, and
 * behold leans on chant's MCP for the underlying graph/lifecycle data (see README).
 */
import { resolve, dirname, join } from "node:path";
import { realpathSync, existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { startServer, beholdVersion } from "./server.ts";
import { loadDemoRegistry, missingRequirements, demoTargetDir, loadDemo, type DemoCarve } from "./demos.ts";
import { resolveChant } from "./chant.ts";
import { runExport } from "./export.ts";
import { diagnose, formatReport } from "./doctor.ts";
import { isAutoSyncMode, type AutoSyncMode } from "./autosync.ts";
import { detectProjectShape } from "./project.ts";
import { readCarveReport } from "./carve-lens.ts";
import {
  bootScratchFloci,
  teardownScratchFloci,
  applyIntoFloci,
  LIVE_CONTAINER,
  LIVE_PORT,
  LIVE_TARGETS,
  type CarveLiveInfo,
} from "./carve-live.ts";

const USAGE = `behold — a live control plane on chant (read-only core)

Usage:
  behold demo [name] [target-dir] [--port <n>] [--list]
  behold demo carve [--live] [--port <n>]
  behold doctor [project-dir] [--json]
  behold preview [project-dir] [--port <n>] [--emulator]
  behold export [project-dir] [--out <dir>] [--env <name>] [--name <worker>] [--emulator]
  behold serve <project-dir…> [--port <n>] [--env <name>] [--poll <secs>] [--local]
  behold carve <report.json> [--port <n>]

  carve   Render a chant Terraform peelability report — the JSON from
          \`chant carve advise --from <tf-dir> --json\` — as a graph. One card
          per ranked resource, coloured by band: green = carve now, amber =
          has boundary work, grey = leave in Terraform. Click a card for the
          score arithmetic behind its rank. Read-only twice over: chant's
          advisor emits nothing, and behold only draws what it says.
          \`GET /api/carve\` serves the raw report to agents. behold parses no
          Terraform and needs no Terraform tooling — the report is the contract.

  doctor  Why won't this project serve well? A read-only diagnosis of
          everything behold needs — the project's kind, its own chant install
          and version, declared lexicons, the envs the picker will infer, the
          kube context chant binds versus the ambient one, substrate
          readiness, committed Ops — each line pass/warn/fail with a one-line
          fix. Defaults to the current directory. Exits 0 iff nothing failed;
          --json for machines. Starts no server and changes nothing.

  demo    The five-minute path from npm — no chant project needed. A catalog
          of demo estates (behold demo --list): bundled ones copy out of the
          package into a directory that's yours to edit; git ones shallow-
          clone a public estate. Bare \`behold demo\` is the AWS example — an
          S3 bucket + policy on a local emulator: blue = declared, click
          Deploy, watch it turn green. \`behold demo k8s\` stands a workload
          up on a throwaway k3d cluster instead. \`behold demo carve\` is the
          odd one out: no cluster, no Docker, no cloud — a half-migrated
          Terraform/chant estate plus the six-step carve walkthrough on the
          panel's Carve tab. Its \`--live\` tier flips that: docker + terraform
          on PATH, a scratch Floci booted and deleted on exit, the starred
          resources REALLY applied, and a real \`terraform plan\` button at
          Handoff. Needs Docker (and per-demo tools --list names).
          Loaded demos land in the panel's recents, so switching between them
          is the Scope tab — which lists this whole catalog too (#268), one
          click from any served project.

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
  --port <n>          Port (default 4600). preview/serve/carve.
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
  --json              doctor only: the report as JSON (stable keys) instead of
                      the console lines — the AGENTS.md audience.
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

  if (cmd === "doctor") {
    await runDoctor(rest);
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

  if (cmd === "carve") {
    await runCarve(rest);
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
 * the directory may be about to become a project).
 *
 * Shares `detectProjectShape` (#236) with `behold doctor`, so both agree on
 * what a directory is — including the estate-root case, where the right
 * advice is the member list rather than "no chant.config.ts". */
function warnIfNotChantProject(dir: string): void {
  const shape = detectProjectShape(dir);
  if (shape.kind === "project") return;
  if (shape.kind === "estate") {
    process.stderr.write(
      `behold: warning — ${dir} is an estate root, not a chant project itself.\n` +
        `        Serve its members composed: behold serve ${shape.members!.map((m) => join(dir, m)).join(" ")}\n`,
    );
    return;
  }
  process.stderr.write(
    `behold: warning — ${dir} has no chant.config.ts; this doesn't look like a chant project.\n` +
      `        \`behold doctor ${dir}\` says what's missing. No project yet? \`behold demo\` serves a bundled working example (needs Docker).\n`,
  );
}

/** `behold carve <report.json>` (#252, M1 of #230) — render a chant Terraform
 * peelability report.
 *
 * A separate verb rather than a `--carve-report` flag on serve, because it
 * shares none of serve's arguments: there is no project, no env, no poll and no
 * emulator behind a static analysis of foreign Terraform. The only thing the
 * two have in common is a port and the SPA, and both come free from
 * `startServer`.
 *
 * The report is validated HERE as well as per-request in the server, so a typo'd
 * path or a JSON file that isn't a carve report is refused in the terminal
 * (exit 2) rather than becoming a server that only fails once you open it.
 */
async function runCarve(rest: string[]): Promise<void> {
  let port = 4600;
  let fileArg: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--port") port = Number(rest[++i]);
    else if (a === "-h" || a === "--help") return void process.stdout.write(USAGE);
    else if (!a.startsWith("-")) fileArg = a;
    else {
      process.stderr.write(`behold carve: unexpected argument '${a}'\n`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(port)) {
    process.stderr.write("behold carve: --port must be a number\n");
    process.exit(2);
  }
  if (!fileArg) {
    process.stderr.write(
      "behold carve: missing <report.json>\n" +
        "  Generate one: chant carve advise --from <terraform-dir> --report report.json\n",
    );
    process.exit(2);
  }
  const reportPath = resolve(fileArg);
  const parsed = readCarveReport(reportPath, (p) => readFileSync(p, "utf8"));
  if (!parsed.ok) {
    process.stderr.write(`behold carve: ${parsed.refusal.error}\n  ${parsed.refusal.remedy}\n`);
    process.exit(2);
  }
  process.stdout.write(
    `behold carve — ${parsed.report.resources.length} resource(s)/module(s) ranked` +
      `${parsed.report.from ? ` from ${parsed.report.from}` : ""}\n`,
  );
  await startServer({ projectDir: dirname(reportPath), carveReport: reportPath, port });
}

/** `behold doctor` (#236) — the read-only first-touch diagnosis. Composes the
 * probes the server already uses (src/doctor.ts) into one console report;
 * starts nothing, writes nothing. Exit 1 (via `process.exitCode`, so stdout
 * flushes) when any line failed, 0 otherwise — a CI-usable gate on "can behold
 * serve this project well". */
async function runDoctor(rest: string[]): Promise<void> {
  let json = false;
  let dirArg: string | undefined;
  for (const a of rest) {
    if (a === "--json") json = true;
    else if (a === "-h" || a === "--help") return void process.stdout.write(USAGE);
    else if (!a.startsWith("-")) dirArg = a;
    else {
      process.stderr.write(`behold doctor: unexpected argument '${a}'\n`);
      process.exit(2);
    }
  }
  const dir = dirArg ?? ".";
  if (!existsSync(resolve(dir))) {
    process.stderr.write(`behold doctor: no such directory: ${resolve(dir)}\n`);
    process.exit(2);
  }
  const report = await diagnose(dir);
  process.stdout.write(json ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
  if (!report.ok) process.exitCode = 1;
}

/** `behold demo` (#193) — the five-minute path for someone who just ran
 * `npm install @intentius/behold` and has no chant project: copy the bundled
 * example-writes into a directory THEY own (so editing its source and
 * watching the graph react is part of the demo), install its deps, and serve
 * it. #209 grew this into a CATALOG (demos.json, shipped in the package):
 * `--list` prints it with per-demo requirement checks; `demo <name>` loads a
 * bundled (tarball copy) or git (shallow clone) entry. Idempotent: an
 * existing target is reused (and an already-installed one skips npm
 * install), so a second `behold demo` is just "start the demo again". */
async function runDemo(rest: string[]): Promise<void> {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const registry = loadDemoRegistry(pkgRoot);
  let port = 4600;
  let live = false;
  let name: string | undefined;
  let dirArg: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--port") port = Number(rest[++i]);
    else if (a === "--live") live = true;
    else if (a === "--list") {
      if (!registry.length) {
        process.stdout.write("behold demo: no catalog in this install (demos.json missing)\n");
        return;
      }
      for (const e of registry) {
        const missing = missingRequirements(e);
        const ready = missing.length ? `needs ${missing.join(", ")}` : "ready";
        process.stdout.write(`  ${e.name.padEnd(14)} ${ready.padEnd(20)} ${e.description}\n`);
      }
      process.stdout.write("\nRun one: behold demo <name>   (bare `behold demo` = writes)\n");
      return;
    } else if (a === "-h" || a === "--help") return void process.stdout.write(USAGE);
    else if (!a.startsWith("-")) {
      // `demo <name> [target-dir]`, with back-compat for `demo <target-dir>`:
      // a bare arg is a catalog name when it matches one, else the target.
      if (!name && registry.some((e) => e.name === a)) name = a;
      else if (!dirArg) dirArg = a;
      else {
        process.stderr.write(`behold demo: unexpected argument '${a}'\n`);
        process.exit(2);
      }
    } else {
      process.stderr.write(`behold demo: unexpected argument '${a}'\n`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(port)) {
    process.stderr.write("behold demo: --port must be a number\n");
    process.exit(2);
  }
  const entry = registry.find((e) => e.name === (name ?? "writes"));
  if (!entry) {
    process.stderr.write(`behold demo: no "${name ?? "writes"}" in this install's catalog — behold demo --list\n`);
    process.exit(2);
  }
  const missing = missingRequirements(entry);
  if (missing.length) {
    process.stderr.write(`behold demo ${entry.name}: missing ${missing.join(", ")} — install and re-run.\n`);
    process.exit(2);
  }
  // The copy/clone → install → setup half lives in demos.ts (#268), because
  // the panel's demo catalog (POST /api/demos/open) loads a demo through the
  // very same function — one path, whichever surface starts it.
  const target = dirArg ? resolve(dirArg) : demoTargetDir(entry);
  const loaded = await loadDemo(entry, { pkgRoot, target, log: (line) => process.stdout.write(line + "\n") });
  if (!loaded.ok) {
    process.stderr.write(`behold demo ${entry.name}: ${loaded.error}\n`);
    process.exit(1);
  }
  // #254: a carve demo isn't a project serve at all — it boots the advisor and
  // hands the walkthrough its estate context.
  if (entry.serve.carve) {
    await serveCarveDemo(target, entry.serve.carve, port, live);
    return;
  }
  if (live) {
    process.stderr.write(`behold demo ${entry.name}: --live is the carve demo's tier — only \`behold demo carve --live\` takes it.\n`);
    process.exit(2);
  }
  process.stdout.write(`behold demo ${entry.name} → serving. Blue = declared; Deploy turns it green.\n`);
  const serveArgs = ["serve", ...loaded.serveDirs, "--port", String(port)];
  if (entry.serve.local) serveArgs.push("--local");
  if (entry.serve.env) serveArgs.push("--env", entry.serve.env);
  await run(serveArgs);
}

/** One child step of the carve boot, output inherited so npm and chant narrate
 * themselves into behold's own terminal. Async (not `spawnSync`) to match the
 * shape demos.ts moved to in #268; a spawn error comes back as -1, never a
 * rejection. */
function spawnStep(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd, shell: process.platform === "win32" });
    child.on("error", () => res(-1));
    child.on("close", (code) => res(code ?? 1));
  });
}

/**
 * `behold demo carve`'s boot (#254, M1.5 of #230) — the offline tier.
 *
 * Three things happen before a port opens, and each is allowed to fail into
 * something visible rather than into a blank page:
 *
 *  1. `npm install` in the copy's chant project (`app/`). Its chant is the one
 *     every step of the walkthrough shells — the project decides the version,
 *     same rule as every other behold shell-out.
 *  2. `@cdktf/hcl2json` into the copy's ROOT `node_modules`. chant lazy-loads
 *     the HCL parser with a bare `import`, resolved from chant's OWN install
 *     upward — `<copy>/app/node_modules/@intentius/chant/…` reaches
 *     `<copy>/node_modules`, which is why the parser goes there and not into
 *     the Terraform directory beside the `.tf` files. `--no-save
 *     --no-package-lock` so the copy never grows a package.json it didn't ship
 *     with.
 *  3. `chant carve advise --report` over the copy's own Terraform, so the
 *     picture is generated on the spot rather than replayed. If it fails —
 *     no network for the parser, a chant too old, a broken install — the
 *     committed `carve-report.json` is served instead and the reason rides all
 *     the way to the UI (`CarveDemo.degraded`). The one thing that must never
 *     happen is an empty graph with no explanation.
 *
 * The Floci `--live` tier (the issue's second comment, src/carve-live.ts) runs
 * BEFORE all that: scratch Floci in Docker, the copy's Terraform really
 * applied into it, so the tfstate the advisor reads was written by terraform.
 * Live fails fast rather than degrading — a "live" walkthrough silently
 * serving synthetic state would be the demo lying about its one claim. The
 * observe beat stays deferred on chant#1647.
 */
async function serveCarveDemo(target: string, carve: DemoCarve, port: number, live = false): Promise<void> {
  const at = (rel: string): string => resolve(target, rel);
  const project = at(carve.project);
  const from = at(carve.from);
  const state = carve.state ? at(carve.state) : undefined;
  const committed = at(carve.report);

  let liveInfo: CarveLiveInfo | undefined;
  if (live) {
    for (const bin of ["docker", "terraform"]) {
      const probe = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
      if (probe.status !== 0) {
        process.stderr.write(`behold demo carve --live: needs ${bin} on PATH (the offline tier doesn't — drop --live).\n`);
        process.exit(2);
      }
    }
    process.stdout.write(`behold demo carve --live → scratch Floci (${LIVE_CONTAINER}, :${LIVE_PORT}, deleted on exit)…\n`);
    const bootErr = await bootScratchFloci();
    if (bootErr) {
      process.stderr.write(`behold demo carve --live: ${bootErr}\n`);
      process.exit(1);
    }
    // From here the server owns the container: startServer's shutdown hook
    // tears it down on SIGINT/SIGTERM. This function only cleans up on the
    // failure paths between boot and serve.
    process.stdout.write("behold demo carve --live → terraform init + apply (the starred resources, into the scratch Floci)…\n");
    if (state) rmSync(state, { force: true }); // the synthetic tfstate — terraform writes the real one
    const applyErr = await applyIntoFloci(from, spawnStep);
    if (applyErr) {
      await teardownScratchFloci();
      process.stderr.write(`behold demo carve --live: ${applyErr}\n`);
      process.exit(1);
    }
    liveInfo = {
      container: LIVE_CONTAINER,
      port: LIVE_PORT,
      endpoint: `http://localhost:${LIVE_PORT}`,
      applied: LIVE_TARGETS,
    };
    process.stdout.write("behold demo carve --live → the tfstate is real now; the advisor reads what terraform wrote.\n");
  }

  if (existsSync(join(project, "package.json")) && !existsSync(join(project, "node_modules"))) {
    process.stdout.write(`behold demo carve → npm install in ${carve.project}/ (the chant this walkthrough shells)…\n`);
    const code = await spawnStep("npm", ["install"], project);
    if (code !== 0) {
      process.stderr.write(`behold demo carve: npm install failed in ${project}\n`);
      process.exit(code || 1);
    }
  }

  let degraded: string | undefined;
  if (!existsSync(join(target, "node_modules", "@cdktf", "hcl2json"))) {
    process.stdout.write("behold demo carve → npm install @cdktf/hcl2json (chant's HCL parser, ~2MB, once)…\n");
    const code = await spawnStep("npm", ["install", "--no-save", "--no-package-lock", "@cdktf/hcl2json"], target);
    if (code !== 0) degraded = "couldn't install @cdktf/hcl2json (chant's HCL parser) — no network?";
  }

  const report = at("carve-report.json");
  if (!degraded) {
    const bin = resolveChant(project).bin;
    process.stdout.write("behold demo carve → chant carve advise (read-only; emits nothing)…\n");
    const code = await spawnStep(
      bin,
      ["carve", "advise", "--from", carve.from, ...(carve.state ? ["--state", carve.state] : []), "--report", report],
      target,
    );
    if (code !== 0) degraded = `chant carve advise exited ${code}`;
  }
  // Fall back to the committed report rather than to nothing — the walkthrough's
  // first frame is the banded graph, and a blank one teaches the viewer that
  // behold breaks. Say so on screen; don't paper over it.
  const serving = !degraded && existsSync(report) ? report : committed;
  if (degraded) {
    process.stderr.write(
      `behold demo carve: ${degraded}\n` +
        `        Serving the committed report (${carve.report}) instead — the bands are real, just not regenerated here.\n`,
    );
  }
  if (!existsSync(serving)) {
    process.stderr.write(`behold demo carve: no carve report at ${serving}\n`);
    process.exit(2);
  }

  process.stdout.write(
    "behold demo carve → serving the walkthrough. Green = carve now; the Carve tab walks the six steps.\n",
  );
  await startServer({
    projectDir: target,
    carveReport: serving,
    carveDemo: {
      root: target,
      from,
      ...(state ? { state } : {}),
      project,
      out: at(carve.out),
      ...(liveInfo ? { live: liveInfo } : {}),
      ...(degraded ? { degraded: `${degraded} — showing the committed report shipped with the demo.` } : {}),
    },
    port,
  });
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
