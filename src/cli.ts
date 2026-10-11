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
import { resolveChant, runChantRaw } from "./chant.ts";
import { applyConversion, planConversion } from "./workspace-convert.ts";
import { publishBundle, publishTarget, runExport } from "./export.ts";
import { hasEnvCredentials, S3Object, s3FromEnv } from "./s3-object.ts";
import { diagnose, formatReport } from "./doctor.ts";
import { isAutoSyncMode, type AutoSyncMode } from "./autosync.ts";
import { detectProjectShape, loadBeholdConfig } from "./project.ts";
import { drawnMembers, hasDeclaration, readWorkspace, undrawnMembers, unreadableMembers, type Workspace } from "./workspace.ts";
import { hudAddress } from "./workspace-why.ts";
import { servesAsEstate } from "./member-kind.ts";
import { setChoudoufuSpawnEnv } from "./choudoufu-member.ts";
import { readCarveReport } from "./carve-lens.ts";
import { HCL_PARSER_PKG } from "./terraform-member.ts";
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
  behold doctor [project-dir] [--json] [--fix]
  behold preview [project-dir] [--port <n>] [--emulator]
  behold export [project-dir] [--out <dir>] [--env <name>] [--name <worker>] [--emulator]
                [--terragucci <src> [--terragucci-project <p>] [--reports-base <rel>]] [--no-source]
                [--publish s3://<bucket>/<prefix>/views/<name>]
  behold serve <project-dir…> [--port <n>] [--host <addr>] [--allow-host <name,…>] [--hud <url>] [--env <name>] [--poll <secs>] [--local]
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
          clone a public estate; and in a checkout, the workbench block lists
          whatever workbench.json names on this machine (#388). Bare
          \`behold demo\` is the AWS example — an
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
          browser, coloured by drift. Reads only; writes are commands it starts. Pass several
          project dirs to compose them into one estate (#31): per-project
          boundary boxes + cross-stack edges. The first is the primary (ops,
          overlay, and rollback act on it).

Options:
  --port <n>          Port (default 4600). preview/serve/carve.
  --host <addr>       serve only: the address to bind (default 127.0.0.1, or
                      BEHOLD_HOST). behold runs writes with your credentials,
                      so it answers this machine unless you say otherwise.
  --allow-host <n,…>  serve only: names besides loopback behold answers to, and
                      whose pages may write (BEHOLD_ALLOWED_HOSTS too). For a
                      proxy that frames behold, or --host 0.0.0.0.
  --hud <url>         serve only: where hud reviews this workspace's records
                      (BEHOLD_HUD_URL too). A proposed decision in a member's
                      or a card's "why" links to its review there (#471).
  --terragucci <src>  serve/export: paint a terragucci estate from its reports
                      (#490). <src> is a report directory (a synced bucket
                      prefix, or <prefix>/<project>), s3://bucket/prefix (read
                      with your aws CLI, GetObject only), or an https address
                      that serves the bucket. Each root's newest tf-plan and
                      tf-drift verdict is marked on its cards with the run's
                      age and a link to its report; nothing is read from a
                      cloud, and a waiting wave offers only the line to run.
  --terragucci-project <host/path>
                      serve/export: which project, when the reports hold several
                      and none is this checkout's git remote.
  --terragucci-poll <secs>
                      serve with --terragucci only: while a page is open, ask
                      whether index.json changed (If-None-Match, or its mtime)
                      and fetch chant/lifecycle (the gates and locks) every
                      <secs> (default 30), and push what moved to the page.
                      0 turns it off. The fetch goes into behold's own cache
                      (<tmpdir>/behold-lifecycle-*), never into the checkout.
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
  --fix               doctor only: write chant.workspace.json for an estate
                      root that lists its members in .behold.json, move its
                      saved layout to the root, and run chant workspace check.
                      The one doctor that writes (#464).
  --out <dir>         export only: output directory (default ./behold-export).
  --no-source         export only: leave each card's source text out of the
                      bundle (a Terraform root's whole file rides on its cards
                      as attrs.source otherwise).
  --publish <s3://b/p/views/name>
                      export only: also upload the bundle there, each file
                      with its content type, signed with AWS credentials from
                      the environment. Only under a views/<name> directory
                      (terragucci never writes there), so a bundle never
                      overwrites a page it did not make. The one cloud write
                      behold makes, and only when an export asks for it.
  --reports-base <r>  export with --terragucci only: where a report link points
                      from the bundle, relative to it (default ../../, for a
                      bundle uploaded to <prefix>/views/behold/).
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
  let host: string | undefined;
  let hudArg: string | undefined = process.env.BEHOLD_HUD_URL || undefined;
  let terragucci: string | undefined;
  let terragucciProject: string | undefined;
  let terragucciPoll: number | undefined;
  const allowHosts: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--port") port = Number(rest[++i]);
    else if (a === "--host") host = rest[++i];
    else if (a === "--allow-host") allowHosts.push(...(rest[++i] ?? "").split(","));
    else if (a === "--hud") hudArg = rest[++i];
    else if (a === "--terragucci") terragucci = rest[++i];
    else if (a === "--terragucci-project") terragucciProject = rest[++i];
    else if (a === "--terragucci-poll") terragucciPoll = Number(rest[++i]);
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
  const hud = hudAddress(hudArg);
  if (hudArg && !hud) {
    process.stderr.write(`behold serve: --hud must be an http or https address, not ${JSON.stringify(hudArg)}\n`);
    process.exit(2);
  }

  if (terragucci !== undefined && !terragucci) {
    process.stderr.write("behold serve: --terragucci needs a report directory, s3://bucket/prefix or an https address\n");
    process.exit(2);
  }
  if (terragucciProject && terragucci === undefined) {
    process.stderr.write("behold serve: --terragucci-project needs --terragucci\n");
    process.exit(2);
  }
  if (terragucciPoll !== undefined && (!Number.isFinite(terragucciPoll) || terragucciPoll < 0)) {
    process.stderr.write("behold serve: --terragucci-poll must be a number of seconds, 0 for off\n");
    process.exit(2);
  }
  if (terragucciPoll !== undefined && terragucci === undefined) {
    process.stderr.write("behold serve: --terragucci-poll needs --terragucci\n");
    process.exit(2);
  }
  const dirs = projectDirs.map((d) => resolve(d));
  const target = await serveTarget(dirs, "serve");
  await startServer({
    ...target,
    port,
    ...(env ? { env } : {}),
    ...(pollSecs !== undefined ? { pollSecs } : {}),
    ...(autoSync !== "off" ? { autoSync } : {}),
    ...(local ? { local: true } : {}),
    ...(host ? { host } : {}),
    ...(allowHosts.length ? { allowedHosts: allowHosts } : {}),
    ...(target.workspace && hud ? { hud } : {}),
    ...(terragucci ? { terragucci: { source: terragucci, ...(terragucciProject ? { project: terragucciProject } : {}), ...(terragucciPoll !== undefined ? { pollSecs: terragucciPoll } : {}) } } : {}),
  });
}

/** What `serve` and `export` read for the directories on the command line. */
type ServeTarget = { projectDir: string; projectDirs?: string[]; workspace?: Workspace };

/**
 * #464: one directory holding a chant.workspace.json is a declared workspace,
 * served from chant's member list. Anything else is the loose view (ws-019).
 * #489: a declaration with no members (terragucci ships one, for its gates
 * and not as an estate) declares nothing to draw, so the directory is read
 * the way it would be without one, and startup says so.
 */
async function serveTarget(dirs: string[], verb: "serve" | "export"): Promise<ServeTarget> {
  const workspace = dirs.length === 1 && hasDeclaration(dirs[0]) ? await declaredWorkspace(dirs[0], verb) : undefined;
  if (workspace && workspace.members.length > 0) {
    const drawn = drawnMembers(workspace).map((m) => m.abs);
    return { projectDir: drawn[0] ?? workspace.root, projectDirs: drawn, workspace };
  }
  for (const d of dirs) warnIfNotChantProject(d);
  return {
    projectDir: dirs[0], // primary — ops/overlay/rollback act on it
    // #389: more than one directory composes, and so does one that is a member
    // of a kind chant cannot read — a lone choudoufu estate has no chant to
    // shell, so it is served as a one-member estate rather than through the
    // single-project read that would answer "no lexicon detected".
    ...(servesAsEstate(dirs) ? { projectDirs: dirs } : {}),
  };
}

/** Read the declared workspace at `root` for `serve`, or exit with chant's
 * reason. Says at startup what the picture will and won't hold: members chant
 * cannot read are drawn as unreadable boxes, `other` members are listed and
 * draw nothing, and a `.behold.json` member list beside the declaration is
 * ignored (ws-015). */
async function declaredWorkspace(root: string, verb: "serve" | "export"): Promise<Workspace> {
  const read = await readWorkspace(root);
  if (!read.ok) {
    process.stderr.write(`behold ${verb}: ${read.refusal.error}\n        ${read.refusal.remedy}\n`);
    process.exit(1);
  }
  const ws = read.workspace;
  if (ws.members.length === 0) {
    process.stdout.write(`behold: ${ws.file} (workspace ${ws.name}) declares no members, so behold reads ${root} as it would without one\n`);
    return ws;
  }
  const drawn = drawnMembers(ws);
  process.stdout.write(`behold: serving chant workspace ${ws.name} (${ws.file}), ${drawn.length} of ${ws.members.length} members drawn\n`);
  for (const m of unreadableMembers(ws)) process.stdout.write(`        ${m.name}: unreadable, ${m.reason!.code}: ${m.reason!.message}\n`);
  for (const m of undrawnMembers(ws)) process.stdout.write(`        ${m.name}: kind ${m.kind}, listed and not drawn${m.because ? ` (${m.because})` : ""}\n`);
  if (loadBeholdConfig(root).members) {
    process.stderr.write(`behold: warning — ${root}/.behold.json lists members, and chant.workspace.json does too; the declaration wins and .behold.json's members are ignored.\n`);
  }
  return ws;
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
  // #387: the one-member "the directory is itself a member" shape is servable
  // as it stands (a choudoufu estate with its sidecar), so there is nothing to
  // warn about — the member list would only name the directory again.
  if (shape.kind === "estate" && shape.membersFrom === "itself") return;
  if (shape.kind === "estate") {
    process.stderr.write(
      `behold: warning — ${dir} is an estate root, not a chant project itself.\n` +
        `        Serve its members composed: behold serve ${shape.members!.map((m) => join(dir, m.dir)).join(" ")}\n`,
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
  let fix = false;
  let dirArg: string | undefined;
  for (const a of rest) {
    if (a === "--json") json = true;
    else if (a === "--fix") fix = true;
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
  if (fix) return runDoctorFix(dir);
  const report = await diagnose(dir);
  process.stdout.write(json ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
  if (!report.ok) process.exitCode = 1;
}

/** `behold doctor --fix` (#464, ws-015): write the chant workspace declaration
 * for an estate served from a member list, move its saved layout to the root,
 * and have chant check what was written. The only doctor that writes, and it
 * writes only on this flag; see src/workspace-convert.ts for the two files. */
async function runDoctorFix(dir: string): Promise<void> {
  const planned = planConversion(dir);
  if (!planned.ok) {
    process.stderr.write(`behold doctor --fix: ${planned.error}\n`);
    process.exitCode = 1;
    return;
  }
  const { plan } = planned;
  const wrote = applyConversion(plan);
  process.stdout.write(`wrote ${wrote.declaration} (${plan.declaration.members.length} members)\n`);
  if ("wrote" in wrote.layout) process.stdout.write(`moved the saved layout to ${wrote.layout.wrote} (${wrote.layout.ids} node ids)\n`);
  else process.stdout.write(`layout: ${wrote.layout.skipped}\n`);
  for (const n of plan.notes) process.stdout.write(`note: ${n}\n`);
  if (plan.from === "behold-config") process.stdout.write(`.behold.json's members are ignored from now on, since the declaration lists them; you can delete them.\n`);
  const check = await runChantRaw(["workspace", "check", "--format", "json"], plan.root);
  process.stdout.write(check.code === 0 ? "chant workspace check: passed\n" : `chant workspace check failed (exit ${check.code}):\n${check.stdout || check.stderr}\n`);
  if (check.code !== 0) process.exitCode = 1;
}

/** `behold demo` (#193) — the five-minute path for someone who just ran
 * `npm install @intentius/behold` and has no chant project: copy the bundled
 * example-writes into a directory THEY own (so editing its source and
 * watching the graph react is part of the demo), install its deps, and serve
 * it. #209 grew this into a CATALOG (demos.json, shipped in the package):
 * `--list` prints it with per-demo requirement checks; `demo <name>` loads a
 * bundled (tarball copy), git (shallow clone) or — in a checkout — local
 * (#388: copied, served in place, or rendered by its own setup) entry.
 * Idempotent: an existing target is reused (and an already-installed one skips
 * npm install), so a second `behold demo` is just "start the demo again". */
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
      // #388: two catalogs, two blocks. The bundled ones ship in the tarball
      // and are the same everywhere; the workbench ones are this checkout's,
      // and an entry whose sibling is not checked out says so in the same
      // place a missing binary does.
      const block = (heading: string, entries: typeof registry): void => {
        if (!entries.length) return;
        process.stdout.write(`${heading}\n`);
        for (const e of entries) {
          const missing = missingRequirements(e);
          const ready = missing.length ? `needs ${missing.join(", ")}` : "ready";
          process.stdout.write(`  ${e.name.padEnd(14)} ${ready.padEnd(20)} ${e.description}\n`);
        }
      };
      block("bundled", registry.filter((e) => (e.catalog ?? "demos") === "demos"));
      const workbench = registry.filter((e) => e.catalog === "workbench");
      if (workbench.length) process.stdout.write("\n");
      block("workbench (this checkout)", workbench);
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
  // #372: the demo's scratch emulator reaches the estate's choudoufu spawns
  // through this seam, in this process, which `serve` below shares.
  setChoudoufuSpawnEnv(entry.serve.spawnEnv);
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
 *  2. `@cdktn/hcl2json` into the copy's ROOT `node_modules`. chant lazy-loads
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
 * observe beat rides it (chant#1647, fixed at chant ≥ 0.44.12): after Emit,
 * chant reads the carved resource live from the carveout while Terraform
 * still owns it.
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
  if (!existsSync(join(target, "node_modules", ...HCL_PARSER_PKG.split("/")))) {
    process.stdout.write(`behold demo carve → npm install ${HCL_PARSER_PKG} (chant's HCL parser, ~2MB, once)…\n`);
    const code = await spawnStep("npm", ["install", "--no-save", "--no-package-lock", HCL_PARSER_PKG], target);
    if (code !== 0) degraded = `couldn't install ${HCL_PARSER_PKG} (chant's HCL parser) — no network?`;
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
  let terragucci: string | undefined;
  let terragucciProject: string | undefined;
  let reportsBase: string | undefined;
  let publish: string | undefined;
  let noSource = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") outDir = resolve(rest[++i]);
    else if (a === "--env") env = rest[++i];
    else if (a === "--name") name = rest[++i];
    else if (a === "--emulator") emulator = true;
    else if (a === "--terragucci") terragucci = rest[++i];
    else if (a === "--terragucci-project") terragucciProject = rest[++i];
    else if (a === "--reports-base") reportsBase = rest[++i];
    else if (a === "--no-source") noSource = true;
    else if (a === "--publish") publish = rest[++i];
    else if (a === "-h" || a === "--help") return void process.stdout.write(USAGE);
    else if (!a.startsWith("-")) dirArg = a;
  }
  if ((terragucciProject || reportsBase !== undefined) && !terragucci) {
    process.stderr.write("behold export: --terragucci-project and --reports-base need --terragucci\n");
    process.exit(2);
  }

  // #491: checked before anything is captured, so a destination that would
  // be refused costs nothing.
  const destination = publish === undefined ? undefined : publishTarget(publish);
  if (destination && "error" in destination) {
    process.stderr.write(`behold export: ${destination.error}\n`);
    process.exit(2);
  }
  if (destination && !hasEnvCredentials()) {
    process.stderr.write(
      "behold export: --publish signs with AWS credentials from the environment (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE), and there are none.\n" +
        "        In a job, the step that gives it an identity sets them; on a laptop, eval \"$(aws configure export-credentials --format env)\" first.\n",
    );
    process.exit(2);
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
  // The same reading of the directory `serve` would make, so an export of a
  // declared workspace or a Terraform estate captures what serve draws.
  const target = await serveTarget([projectDir], "export");
  await runExport(
    {
      ...target,
      port: 0,
      ...(env ? { env } : {}),
      ...(terragucci ? { terragucci: { source: terragucci, ...(terragucciProject ? { project: terragucciProject } : {}) } } : {}),
    },
    outDir,
    { ...(name ? { name } : {}), ...(noSource ? { noSource } : {}), ...(reportsBase !== undefined ? { reportsBase } : {}) },
  );
  if (destination && !("error" in destination)) {
    const done = await publishBundle(outDir, destination, new S3Object(s3FromEnv(destination.bucket)));
    process.stdout.write(
      `  Published: ${done.files} files to s3://${destination.bucket}/${destination.prefix}/` +
        (done.removed.length ? `, ${done.removed.length} stale snapshot${done.removed.length === 1 ? "" : "s"} removed` : "") +
        "\n",
    );
    for (const w of done.warnings) process.stderr.write(`  warning: ${w}\n`);
  }
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
