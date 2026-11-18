/**
 * behold#1161: record the ask demo's loop from real behold answers.
 *
 *   just ask-demo-record
 *   (bash e2e/lib/safe-env.sh npx tsx scripts/ask-demo/record.ts [--out <file>])
 *
 * It boots an estate on emulators, asks it the questions in ./questions.ts
 * through `behold mcp` as a coding agent would, and writes
 * ask-demo/narration.json, the file behold#1163's page plays. It prints one
 * verdict line per question. A question that errors or answers nothing is
 * dropped from the file and named; the run fails when fewer than three
 * questions are left.
 *
 * The estate, all on this machine:
 *
 *  1. example-three-cloud, copied to a scratch directory and applied one
 *     member at a time with its own scripts/front-door.ts (apply-gcp,
 *     apply-azure, apply-aws, apply-dns) on floci, floci-az and floci-gcp:
 *     gcp and dns are chant members, azure a choudoufu estate, aws a Pulumi
 *     program on plunge.
 *  2. Two objects made in the AWS account outside the workspace (an S3
 *     bucket and an IAM role), so the account holds what nothing declares,
 *     then `behold index aws` of the account with no project.
 *  3. A kind cluster with two ServiceAccounts whose IRSA annotations name
 *     roles in that account (one the aws program made, one made by hand),
 *     then `behold index kubernetes` of it.
 *  4. `behold serve` of the copy, which loads the workspace, both index
 *     versions and the azure estate's engine graph into one graph database.
 *
 * Then `behold mcp --url <serve>` starts over stdio, the MCP SDK's client
 * calls `ask` once per question, and each answer becomes a turn
 * (./narration.ts). The cards to light come from GET /api/graph, the view
 * the export opens on.
 *
 * behold#1163: the page draws that same estate, so the run also keeps it
 * beside the narration, in ask-demo/estate/: graph.json, the GET /api/graph
 * answer the cards came from, and graphdb.json, the graph pane's rows as
 * `behold export --graphdb` of the same copy writes them, which a visitor's
 * Cypher runs on in the page. Paths of this machine are taken out of both.
 *
 * Needs Docker, kind, kubectl, the aws CLI, choudoufu v0.22.0 or newer
 * (CHOUDOUFU_BIN or PATH) and plunge (PLUNGE_BIN or PATH). Runs only under
 * e2e/lib/safe-env.sh, which clears every real cloud credential first.
 *
 * Scratch discipline (src/scratch.ts): the containers and the cluster are
 * named in ./scratch.ts, all `behold-*`, on their own ports. The run refuses
 * when one already exists, and on exit removes those by name, the cluster
 * it made, and the containers the emulators started for the estate's apps
 * during this run (labelled floci=true, absent before it booted).
 */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { exportScrubber } from "../../src/export.ts";
import { GRAPHDB_FILE, isGraphDbFile } from "../../src/graph-db/graphdb-file.ts";
import { isIndexDocument } from "../../src/graph-db/types.ts";
import { assertScratch } from "../../src/scratch.ts";
import { indexVersionName } from "@intentius/chant/lifecycle/index-document";
import { NARRATION_FORMAT, askAll, validateNarration, cardIndex, checkQuestions, loadTurn, type IrNodeLike, type Narration, type SourceStamp } from "./narration.ts";
import { LOAD, QUESTIONS } from "./questions.ts";
import { REAL_AWS_COMMAND, REAL_AWS_FILE } from "./real-aws.ts";
import { foreignAccountIds, REDACTED_ACCOUNT } from "./redact.ts";
import { ASK_DEMO_CONTAINERS, ASK_DEMO_CONTEXT, ASK_DEMO_SCRATCH } from "./scratch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const CLI = join(ROOT, "src", "cli.ts");

/** The command that re-records the file, as the narration names it. */
export const RECORD_COMMAND = "just ask-demo-record";
/** At least this many questions must answer, or nothing is written. */
export const MIN_QUESTIONS = 3;
/** The account floci answers as. */
const ACCOUNT = "000000000000";
const REGION = "us-east-1";
/** The cluster's namespace the ServiceAccounts live in, and the only one indexed. */
const NAMESPACE = "orders";

const say = (s: string) => process.stdout.write(`ask-demo: ${s}\n`);

class Refusal extends Error {}

function run(cmd: string, args: string[], o: SpawnSyncOptions & { quiet?: boolean } = {}): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: o.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"], ...o });
  if (r.error) throw new Refusal(`${cmd} did not start: ${r.error.message}`);
  if (r.status !== 0) throw new Refusal(`${cmd} ${args.join(" ")} exited ${r.status}${o.quiet ? `: ${String(r.stderr ?? "").trim().split("\n").slice(-6).join("\n")}` : ""}`);
  return String(r.stdout ?? "");
}

function have(cmd: string): boolean {
  return spawnSync(cmd, ["--help"], { stdio: "ignore" }).error === undefined;
}

/** A binary named by `envVar` or found on PATH, or a refusal saying how to get it. */
function binary(envVar: string, name: string, how: string): string {
  const named = process.env[envVar];
  if (named) {
    if (!existsSync(named)) throw new Refusal(`${envVar} names ${named}, which does not exist`);
    return resolve(named);
  }
  const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  if (!found) throw new Refusal(`${name} is not on PATH and ${envVar} is unset: ${how}`);
  return found;
}

function versionAtLeast(have: string, want: string): boolean {
  const a = have.split(".").map(Number);
  const b = want.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

interface Tools {
  choudoufu: string;
  choudoufuVersion: string;
  plunge: string;
  plungeVersion: string;
}

function preflight(): Tools {
  if (!process.env.BEHOLD_SAFE_ENV_DIR) throw new Refusal(`run this under e2e/lib/safe-env.sh, which clears real cloud credentials first: ${RECORD_COMMAND}`);
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) throw new Refusal("Docker is not running");
  for (const t of ["kind", "kubectl", "aws"]) if (!have(t)) throw new Refusal(`${t} is not on PATH`);
  const choudoufu = binary("CHOUDOUFU_BIN", "choudoufu", "the azure member needs choudoufu v0.22.0 or newer (gh release download -R INTENTIUS/choudoufu)");
  const choudoufuVersion = /choudoufu v([0-9.]+)/.exec(run(choudoufu, ["version"], { quiet: true }))?.[1] ?? "";
  if (choudoufuVersion && !versionAtLeast(choudoufuVersion, "0.22.0")) throw new Refusal(`${choudoufu} is choudoufu v${choudoufuVersion}; the azure member's set plan needs v0.22.0 or newer`);
  const plunge = binary("PLUNGE_BIN", "plunge", "the aws member runs on plunge (gh release download -R INTENTIUS/plunge); its directory holds the nodejs language host");
  const plungeVersion = /v?([0-9]+\.[0-9]+\.[0-9]+)/.exec(run(plunge, ["version"], { quiet: true }))?.[1] ?? "unknown";
  return { choudoufu, choudoufuVersion: choudoufuVersion || "dev", plunge, plungeVersion };
}

// ---------------------------------------------------------------------------
// Scratch: what this run boots, and what it removes.
// ---------------------------------------------------------------------------

const made = { containers: false, cluster: false, kubeconfig: "", flociBefore: new Set<string>(), serve: undefined as ChildProcess | undefined };

function flociChildren(): string[] {
  return run("docker", ["ps", "-aq", "--no-trunc", "--filter", "label=floci=true"], { quiet: true }).split("\n").filter(Boolean);
}

function refuseTaken(): void {
  for (const c of ASK_DEMO_CONTAINERS) assertScratch(c.name, c.port);
  assertScratch(ASK_DEMO_SCRATCH.cluster.name);
  assertScratch(`${ASK_DEMO_SCRATCH.cluster.name}-control-plane`);
  assertScratch("behold-ask-demo-serve", ASK_DEMO_SCRATCH.serve.port);
  const names = run("docker", ["ps", "-a", "--format", "{{.Names}}"], { quiet: true }).split("\n");
  for (const c of [...ASK_DEMO_CONTAINERS, { name: `${ASK_DEMO_SCRATCH.cluster.name}-control-plane` }]) {
    if (names.includes(c.name)) throw new Refusal(`${c.name} already exists: a previous run didn't tear down; \`docker rm -f ${c.name}\` and re-run`);
  }
  if (run("kind", ["get", "clusters"], { quiet: true }).split("\n").includes(ASK_DEMO_SCRATCH.cluster.name)) {
    throw new Refusal(`kind cluster ${ASK_DEMO_SCRATCH.cluster.name} already exists: \`kind delete cluster --name ${ASK_DEMO_SCRATCH.cluster.name}\` and re-run`);
  }
}

function teardown(): void {
  made.serve?.kill();
  if (made.cluster) spawnSync("kind", ["delete", "cluster", "--name", ASK_DEMO_SCRATCH.cluster.name, "--kubeconfig", made.kubeconfig], { stdio: "ignore" });
  if (made.containers) {
    spawnSync("docker", ["rm", "-f", ...ASK_DEMO_CONTAINERS.map((c) => c.name)], { stdio: "ignore" });
    // The app containers the emulators started for this run's apply: floci's, not behold-* names, and gone with nothing else.
    const startedByRun = spawnSync("docker", ["ps", "-aq", "--no-trunc", "--filter", "label=floci=true"], { encoding: "utf8" }).stdout.split("\n").filter((id) => id && !made.flociBefore.has(id));
    if (startedByRun.length) spawnSync("docker", ["rm", "-f", ...startedByRun], { stdio: "ignore" });
  }
}

// ---------------------------------------------------------------------------
// The estate.
// ---------------------------------------------------------------------------

interface Estate {
  work: string;
  target: string;
  env: NodeJS.ProcessEnv;
  indexDir: string;
  commands: string[];
  /** The region of the real AWS account read that was loaded (behold#1202), if one was. */
  realAws?: string;
}

const SKIP = new Set(["node_modules", ".front-door", "export", ".terraform", ".tofu-records", ".plunge", "stack-export.json", "Pulumi.local.yaml"]);

function bootEstate(tools: Tools): Estate {
  const work = mkdtempSync(join(process.env.BEHOLD_SAFE_ENV_DIR || tmpdir(), "behold-ask-demo-"));
  const target = join(work, "three-cloud");
  const indexDir = join(work, "store", "index");
  const { floci, flociAz, flociGcp } = ASK_DEMO_SCRATCH;
  const aws = `http://localhost:${floci.port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FLOCI_CONTAINER: floci.name,
    FLOCI_AZ_CONTAINER: flociAz.name,
    FLOCI_GCP_CONTAINER: flociGcp.name,
    FLOCI_PORT: String(floci.port),
    FLOCI_AZ_PORT: String(flociAz.port),
    FLOCI_GCP_PORT: String(flociGcp.port),
    AWS_ENDPOINT_URL: aws,
    AZURE_ENDPOINT_URL: `http://localhost:${flociAz.port}`,
    GCP_ENDPOINT_URL: `http://localhost:${flociGcp.port}`,
    CHOUDOUFU_BIN: tools.choudoufu,
    PLUNGE_BIN: tools.plunge,
    PATH: `${dirname(tools.choudoufu)}:${dirname(tools.plunge)}:${process.env.PATH ?? ""}`,
    PULUMI_BACKEND_URL: `file://${join(work, "pulumi-backend")}`,
    PULUMI_SKIP_UPDATE_CHECK: "true",
    BEHOLD_INDEX_DIR: indexDir,
  };
  mkdirSync(join(work, "pulumi-backend"), { recursive: true });
  // The floci key pair, for the aws CLI and behold index; nothing else is in reach under safe-env.
  const awsEnv = { ...env, AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION };

  say(`copy example-three-cloud to ${target} and install it`);
  cpSync(join(ROOT, "example-three-cloud"), target, { recursive: true, filter: (src) => !SKIP.has(src.split("/").pop() ?? "") });
  run("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: target, env });

  say(`boot ${ASK_DEMO_CONTAINERS.map((c) => `${c.name} on :${c.port}`).join(", ")}`);
  made.flociBefore = new Set(flociChildren());
  made.containers = true;
  run("bash", [join(target, "scripts", "emulators-up.sh")], { env, stdio: ["ignore", "inherit", "inherit"] });

  // One member at a time: the components run (`front-door.ts apply`) is not what this records.
  for (const step of ["apply-gcp", "apply-azure", "apply-aws", "apply-dns"]) {
    say(`front-door.ts ${step}`);
    run(join(target, "node_modules", ".bin", "tsx"), ["scripts/front-door.ts", step], { cwd: target, env, stdio: ["ignore", "inherit", "inherit"] });
  }

  say("make an S3 bucket and an IAM role in the account, outside the workspace");
  const awsCli = (...args: string[]) => run("aws", ["--endpoint-url", aws, "--region", REGION, "--output", "json", ...args], { env: awsEnv, quiet: true });
  awsCli("s3api", "create-bucket", "--bucket", "orders-export-archive");
  const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Federated: `arn:aws:iam::${ACCOUNT}:oidc-provider/oidc.eks.${REGION}.amazonaws.com/id/EXAMPLE` }, Action: "sts:AssumeRoleWithWebIdentity" }] };
  awsCli("iam", "create-role", "--role-name", "orders-reader", "--assume-role-policy-document", JSON.stringify(trust));
  const roles = (JSON.parse(awsCli("iam", "list-roles")) as { Roles: Array<{ RoleName: string; Arn: string }> }).Roles;
  const taskRole = roles.find((r) => /^web-task-role-[0-9a-f]{7}$/.test(r.RoleName));
  if (!taskRole) throw new Refusal(`the aws program made no web-task-role; the account's roles are ${roles.map((r) => r.RoleName).join(", ")}`);

  const commands: string[] = [];
  const behold = (args: string[], o: SpawnSyncOptions) => {
    commands.push(`behold ${args.map((a) => (a.startsWith(work) ? relative(work, a) || "." : a)).join(" ")}`);
    return run(TSX, [CLI, ...args], { stdio: ["ignore", "inherit", "inherit"], ...o });
  };
  say("behold index aws, with no project");
  behold(["index", "aws", "--endpoint", aws, "--account", ACCOUNT, "--regions", REGION], { cwd: work, env: awsEnv });

  const realAws = loadRealAws(indexDir, commands);

  say(`kind cluster ${ASK_DEMO_SCRATCH.cluster.name}, with two ServiceAccounts that name roles in the account`);
  made.kubeconfig = join(work, "kubeconfig");
  made.cluster = true;
  run("kind", ["create", "cluster", "--name", ASK_DEMO_SCRATCH.cluster.name, "--kubeconfig", made.kubeconfig, "--wait", "120s"], { env, stdio: ["ignore", "inherit", "inherit"] });
  const sa = (name: string, arn: string) => ({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name, namespace: NAMESPACE, annotations: { "eks.amazonaws.com/role-arn": arn } } });
  const manifest = join(work, "cluster.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      apiVersion: "v1",
      kind: "List",
      items: [{ apiVersion: "v1", kind: "Namespace", metadata: { name: NAMESPACE } }, sa("orders-api", `arn:aws:iam::${ACCOUNT}:role/orders-reader`), sa("web", taskRole.Arn)],
    }),
  );
  run("kubectl", ["--kubeconfig", made.kubeconfig, "--context", ASK_DEMO_CONTEXT, "create", "-f", manifest], { env });
  say("behold index kubernetes");
  behold(["index", "kubernetes", "--kubeconfig", made.kubeconfig, "--context", ASK_DEMO_CONTEXT, "--regions", NAMESPACE], { cwd: work, env });

  commands.push(`behold serve ${relative(work, target)} --port ${ASK_DEMO_SCRATCH.serve.port}`);
  return { work, target, env, indexDir, commands, ...(realAws ? { realAws } : {}) };
}

/**
 * behold#1202: the one read of a real AWS account, made by `just
 * ask-demo-read-real-aws` and kept with its account id redacted, goes into
 * the index store beside the emulator's versions, under the scope key and
 * version name chant would give it. The serve loads it as one more source.
 */
function loadRealAws(indexDir: string, commands: string[]): string | undefined {
  const file = join(ROOT, REAL_AWS_FILE);
  if (!existsSync(file)) {
    say(`no ${REAL_AWS_FILE}, so the question about a real AWS account will answer nothing; ${REAL_AWS_COMMAND} --account <id> makes it`);
    return;
  }
  const doc: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isIndexDocument(doc)) throw new Refusal(`${REAL_AWS_FILE} is not an index version`);
  if (foreignAccountIds(JSON.stringify(doc)).length) throw new Refusal(`${REAL_AWS_FILE} carries an account id that is not ${REDACTED_ACCOUNT}`);
  const version = indexVersionName(doc.stamp.observedAt, (doc.stamp as { digest: string }).digest);
  const dir = join(indexDir, ...doc.stamp.scopeKey.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, version), JSON.stringify(doc));
  const scope = doc.stamp.scope as unknown as { scopeId: string; locations: string[]; types: string[] };
  commands.push(`behold index aws --account ${scope.scopeId} --regions ${scope.locations.join(",")} --types ${scope.types.join(",")}`);
  say(`loaded ${REAL_AWS_FILE}: a real AWS account's ${scope.locations.join(", ")} read on ${doc.stamp.observedAt}, its id replaced by ${REDACTED_ACCOUNT}`);
  return scope.locations.join(", ");
}

async function startServe(e: Estate): Promise<string> {
  const url = `http://localhost:${ASK_DEMO_SCRATCH.serve.port}`;
  say(`behold serve the copy on ${url}`);
  const log = join(e.work, "serve.log");
  const child = spawn(TSX, [CLI, "serve", e.target, "--port", String(ASK_DEMO_SCRATCH.serve.port)], { cwd: e.work, env: e.env, stdio: ["ignore", "pipe", "pipe"] });
  made.serve = child;
  const out: string[] = [];
  child.stdout!.on("data", (d) => out.push(String(d)));
  child.stderr!.on("data", (d) => out.push(String(d)));
  child.on("exit", () => writeFileSync(log, out.join("")));
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`${url}/healthz`)).ok) return url;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Refusal(`behold never answered on ${url}:\n${out.join("").slice(-3000)}`);
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Refusal(`GET ${url} answered ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.text();
}

/** Where the estate the page draws is kept, beside the narration. */
export const ESTATE_DIR = "estate";
export const ESTATE_GRAPH_FILE = "graph.json";

/**
 * behold#1163: keep the estate the answers came from, for the page: the
 * GET /api/graph answer as served, and the graph pane's rows from `behold
 * export --graphdb` of the same copy, with this run's paths taken out. The
 * rows must hold every key a turn names, or the two reads were not of one
 * estate and nothing is kept.
 */
function saveEstate(e: Estate, graphBody: string, turns: Narration["turns"], dir: string): void {
  const exported = join(e.work, "export");
  say(`behold export --graphdb of the copy, for the rows the page's Cypher runs on`);
  run(TSX, [CLI, "export", e.target, "--graphdb", "--out", exported], { cwd: e.work, env: e.env, quiet: true });
  const machine = exportScrubber({ projectDir: e.target });
  const scrub = (text: string) => machine(text).split(e.work).join("scratch");
  const rowsText = scrub(readFileSync(join(exported, GRAPHDB_FILE), "utf8"));
  if (foreignAccountIds(rowsText).length) throw new Refusal(`the exported rows name an AWS account id other than floci's and ${REDACTED_ACCOUNT}; nothing is kept`);
  const rows: unknown = JSON.parse(rowsText);
  if (!isGraphDbFile(rows)) throw new Refusal(`${join(exported, GRAPHDB_FILE)} is not a graphdb.json this build reads`);
  const keys = new Set(rows.rows.resources.map((r) => r.key));
  const missing = turns.flatMap((t) => t.keys.filter((k) => !keys.has(k)).map((k) => `${t.id}: ${k}`));
  if (missing.length) throw new Refusal(`the export's rows lack keys the answers named, so they are not the estate that answered:\n  ${missing.slice(0, 10).join("\n  ")}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ESTATE_GRAPH_FILE), `${JSON.stringify(JSON.parse(scrub(graphBody)))}\n`);
  writeFileSync(join(dir, GRAPHDB_FILE), rowsText);
  say(`kept the estate in ${relative(process.cwd(), dir) || dir}: ${ESTATE_GRAPH_FILE} and ${GRAPHDB_FILE} (${rows.rows.resources.length} resources)`);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Refusal(`GET ${url} answered ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return (await res.json()) as T;
}

function chantVersion(target: string): string {
  return (JSON.parse(readFileSync(join(target, "node_modules", "@intentius", "chant", "package.json"), "utf8")) as { version: string }).version;
}

/** ask-demo/narration.schema.json. */
export function narrationSchema(): object {
  return JSON.parse(readFileSync(join(ROOT, "ask-demo", "narration.schema.json"), "utf8")) as object;
}

async function main(argv: string[]): Promise<number> {
  const outAt = argv.indexOf("--out");
  const out = resolve(outAt >= 0 && argv[outAt + 1] ? argv[outAt + 1]! : join(ROOT, "ask-demo", "narration.json"));
  checkQuestions(QUESTIONS);
  const tools = preflight();
  refuseTaken();
  const onSignal = () => {
    teardown();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const estate = bootEstate(tools);
    const serve = await startServe(estate);
    const graphBody = await getText(`${serve}/api/graph`);
    const graph = JSON.parse(graphBody) as { ir: { nodes: IrNodeLike[] } };
    const cards = cardIndex(graph.ir.nodes);
    const status = await getJson<{ sources: SourceStamp[]; peer: { available: boolean } }>(`${serve}/api/graphdb`);
    if (!status.peer.available) throw new Refusal("the serve has no @ladybugdb/core, so ask cannot answer Cypher; npm install beside behold");
    const load = loadTurn({ prompt: LOAD.prompt, busy: LOAD.busy, commands: estate.commands, reply: LOAD.reply, sources: status.sources, cards });
    say(`load: ${load.reply}`);

    const agentArgs = ["mcp", "--url", serve];
    const transport = new StdioClientTransport({ command: TSX, args: [CLI, ...agentArgs], cwd: estate.target, env: estate.env as Record<string, string>, stderr: "inherit" });
    const client = new Client({ name: "behold-ask-demo-recorder", version: "1" });
    await client.connect(transport);
    let asked: Awaited<ReturnType<typeof askAll>>;
    try {
      asked = await askAll(QUESTIONS, async (args) => (await client.callTool({ name: "ask", arguments: args })) as CallToolResult, cards, serve);
    } finally {
      await client.close();
    }
    process.stdout.write("\n");
    for (const v of asked.verdicts) process.stdout.write(`${v.line}\n`);
    const kept = asked.turns.length;
    process.stdout.write(`\n${kept} of ${QUESTIONS.length} questions answered${kept < QUESTIONS.length ? `; dropped: ${asked.verdicts.filter((v) => !v.ok).map((v) => v.id).join(", ")}` : ""}\n`);
    if (kept < MIN_QUESTIONS) throw new Refusal(`only ${kept} questions answered, fewer than ${MIN_QUESTIONS}; ${out} is left as it was`);

    const beholdVersion = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
    const doc: Narration = {
      $schema: "./narration.schema.json",
      format: NARRATION_FORMAT,
      recordedAt: new Date().toISOString(),
      note:
        "A recording of one run on emulators: example-three-cloud applied to floci, floci-az and floci-gcp, the floci AWS account indexed with behold index aws, and a kind cluster indexed with behold index kubernetes. " +
        (estate.realAws
          ? `The question about SSH reads one more source, not an emulator: an earlier read of a real AWS account's ${estate.realAws} with ${REAL_AWS_COMMAND}, kept with the account id replaced by ${REDACTED_ACCOUNT}. `
          : "") +
        "Each question turn is one behold mcp ask call against behold serve of that estate, with the rows it answered. Nothing here is read when the page plays.",
      recordCommand: RECORD_COMMAND,
      agentCommand: `behold ${agentArgs.join(" ")}`,
      versions: { behold: beholdVersion, chant: chantVersion(estate.target), choudoufu: tools.choudoufuVersion, plunge: tools.plungeVersion },
      turns: [load, ...asked.turns],
    };
    const problems = validateNarration(doc, narrationSchema());
    if (problems.length) throw new Refusal(`the narration does not meet ask-demo/narration.schema.json:\n  ${problems.join("\n  ")}`);
    // behold#1202: nothing is written that names an AWS account but floci's and the redacted placeholder.
    const foreign = foreignAccountIds(`${JSON.stringify(doc)}\n${graphBody}`);
    if (foreign.length) throw new Refusal(`the recording names ${foreign.length} AWS account id(s) other than floci's and ${REDACTED_ACCOUNT}; ${out} is left as it was`);
    saveEstate(estate, graphBody, doc.turns, join(dirname(out), ESTATE_DIR));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
    say(`wrote ${relative(process.cwd(), out) || out}: the load turn and ${kept} questions`);
    return 0;
  } finally {
    teardown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`ask-demo: ${e instanceof Refusal ? e.message : (e as Error).stack ?? String(e)}\n`);
      process.exit(1);
    },
  );
}
