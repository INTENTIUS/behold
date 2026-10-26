/**
 * The front door, rebuilt on the floci emulators: apply the four members,
 * turn Azure off, wait for Route 53 to notice, and export the page.
 *
 *   tsx scripts/front-door.ts all --out <dir>     apply, azure-off, wait and export, in order
 *   tsx scripts/front-door.ts plan --out <file>   one change set over the four members, a part per engine:
 *                                                 `chant lifecycle plan` for dns and gcp, chant's
 *                                                 choudoufuPlanSet Op activity for the azure estate and `plunge
 *                                                 preview` (pulumiPreviewPart) for the aws program,
 *                                                 composed under one digest
 *   tsx scripts/front-door.ts apply [--change-set <file>]
 *                                                 run gcp's component with `chant run --components` in a
 *                                                 copy of the workspace, apply the azure estate, `plunge
 *                                                 up` the aws program, run dns's components, and wait
 *                                                 until `chant lifecycle health` reads azureCheck healthy.
 *                                                 With --change-set, the four members are planned again
 *                                                 first, and when any part's plan is not the one in the
 *                                                 file the whole set is refused and nothing is applied
 *   tsx scripts/front-door.ts pr-plan-dns --base <ref> --out <dir>
 *                                                 dns's pull-request plan of the change from <ref> to
 *                                                 HEAD (`chant components pr-plan --member dns`), under
 *                                                 the floci-az lock; writes pr-plan.json and
 *                                                 change-set.json to <dir>, applies nothing
 *   tsx scripts/front-door.ts build-dns           the dns records component's Build step: dns/dist/dns.json,
 *                                                 its gcp parameter defaulted to what is applied and its
 *                                                 checks pointed at the emulators
 *   tsx scripts/front-door.ts oob-edit <member>   one edit to a member's live resources that its source
 *                                                 does not make, on the emulators, so its card changes
 *                                                 colour: dns's hosted zone comment, gcp's Cloud Run
 *                                                 labels, azure's Container App tags, aws's log group
 *                                                 retention
 *   tsx scripts/front-door.ts azure-off           deactivate the Azure app's active revision
 *   tsx scripts/front-door.ts wait                until azureCheck reads unhealthy
 *   tsx scripts/front-door.ts export --out <dir>  behold export, opening on env local at the components zoom
 *
 * dns/ops/front-door.op.ts runs the same steps as an Op's phases. The emulators
 * are the ones `behold demo three-cloud` boots (chant-floci, chant-floci-az,
 * chant-floci-gcp); FLOCI_CONTAINER, FLOCI_AZ_CONTAINER and FLOCI_GCP_CONTAINER
 * name others, and AWS_ENDPOINT_URL, AZURE_ENDPOINT_URL and GCP_ENDPOINT_URL
 * say where they answer.
 *
 * The components run in a copy of the workspace (.front-door/run) whose git
 * remote is a bare repository beside it (.front-door/run-remote.git). chant
 * records each component's release on that remote's chant/lifecycle branch, so
 * the exported page shows a real last release on every component card, and
 * nothing is pushed anywhere but this directory. The export reads the copy.
 *
 * The azure member is a choudoufu estate (azure/*.tf, INTENTIUS/choudoufu#2246).
 * It is planned and applied here in the workspace itself, through the
 * terraform lexicon's activities and the root's chant.config.json, which
 * names it as the lexicon's `azure` root: choudoufuPlanSet, run as an Op
 * activity (planAzureSet), runs `choudoufu live-plan-set` over it, and
 * choudoufuWaveApply applies exactly that set.
 * Its record store and provider schemas stay in azure/, and the copy links
 * to them. choudoufu is the one on PATH, or CHOUDOUFU_BIN. Every choudoufu
 * call runs under the floci-az endpoint lock choudoufu's own Azure estates
 * use (lockAzureEnv), so nothing it starts can reach a real subscription.
 *
 * The aws member is a Pulumi program on plunge (aws/index.ts, behold#1000),
 * its backend plunge's record backend in aws/.plunge (Pulumi.yaml). It is
 * planned with the pulumi lexicon's previewPulumiMember, which runs `plunge
 * preview --json` and reads it with pulumiPreviewPart, and applied here with
 * `plunge up` on the stack named after the environment, after which `plunge
 * stack export` writes aws/stack-export.json, the export chant reads the
 * member's graph from. plunge is the one on PATH, or PLUNGE_BIN. Every plunge
 * call runs under the floci lock (lockAwsEnv): floci's fake key pair, no
 * Pulumi Cloud login or backend from the shell, and an AWS_ENDPOINT_URL on
 * this machine or nothing runs.
 *
 * dns reads azure's azureEndpoint and aws's awsEndpoint through chant
 * (INTENTIUS/chant#4455): dns/src/records.component.ts has an `azure` and an
 * `aws` component whose `member-outputs` steps read the estate through
 * choudoufu and the stack through plunge, and its records step's cfn-deploy
 * takes `stackOutput("azure", "azureEndpoint")` and `stackOutput("aws",
 * "awsEndpoint")` as those parameters. So dns's components run under both
 * locks (lockedChildEnv). gcpEndpoint is still read here, by build-dns, from
 * what is applied.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeChangeSet, lifecyclePlanPart, verifyChangeSetDigest, type ChangeSetDocument, type ChangeSetPart } from "@intentius/chant/change-set";
import { PLAN_MOVED_EXIT_CODE } from "@intentius/chant/components/capability";
import { planCoveredBy } from "@intentius/chant/components/pr-run";
import type { ChangeSet as LifecycleChangeSet } from "@intentius/chant/lifecycle/change-set";
import type { OpConfig } from "@intentius/chant/op";
import { awsApply } from "@intentius/chant-lexicon-aws/op/activities";
import { gcpApply } from "@intentius/chant-lexicon-gcp/op/activities";
import { choudoufuPlanSet, choudoufuWaveApply, terraformOutputs, type ChoudoufuPlanSetResult } from "@intentius/chant-lexicon-terraform/op/activities/terraform";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The pulumi lexicon, loaded by the aws plan alone (behold#1005). It is on no
 * chant release on npm yet, so this directory's package.json does not list it
 * until behold's CHANT_RELEASE (src/chant-release.ts) is released, and `npm ci`
 * here does not install it. Loading it here, not at the top, lets every other
 * subcommand (apply-azure among them) run without it.
 */
async function pulumiRun(): Promise<typeof import("@intentius/chant-lexicon-pulumi/run")> {
  try {
    return await import("@intentius/chant-lexicon-pulumi/run");
  } catch (e) {
    throw new Error(`the aws part needs @intentius/chant-lexicon-pulumi, which is not installed here: install the local chant build (README, "A local chant build"). ${(e as Error).message}`);
  }
}
const WORK = join(ROOT, ".front-door");
const CHANT = join(ROOT, "node_modules", ".bin", "chant");
/** The copy the components run in, and the bare repository it pushes its release records to. */
const RUN = join(WORK, "run");
const REMOTE = join(WORK, "run-remote.git");

const ENV = "local";
// The Azure resource group, named after the environment, and the GCP
// project, as the members declare them.
const RESOURCE_GROUP = ENV;
const GCP_PROJECT = process.env.GCP_PROJECT_ID ?? "three-cloud";
const GCP_REGION = process.env.GCP_REGION ?? "asia-northeast1";
// The subscription, tenant and client the azure estate's provider block names (azure/main.tf).
const SUBSCRIPTION = "00000000-0000-0000-0000-000000000001";
const TENANT = "00000000-0000-0000-0000-000000000002";
const CLIENT = "00000000-0000-0000-0000-000000000003";
/** The chant lexicon root the azure estate is, in ./chant.config.json. */
const AZURE_ROOT = { root: "azure", cwd: ROOT };

const AWS = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const AZURE = process.env.AZURE_ENDPOINT_URL ?? "http://localhost:4577";
/** floci-az's host:port, which the azure estate's provider reaches over TLS as its metadata host. */
const AZURE_HOST = new URL(AZURE).host;
const GCP = process.env.GCP_ENDPOINT_URL ?? "http://localhost:4588";
const CONTAINERS = {
  aws: process.env.FLOCI_CONTAINER ?? "chant-floci",
  azure: process.env.FLOCI_AZ_CONTAINER ?? "chant-floci-az",
  gcp: process.env.FLOCI_GCP_CONTAINER ?? "chant-floci-gcp",
};

/** Everything a chant or behold child needs to reach the emulators. */
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  AWS_ENDPOINT_URL: AWS,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
  AZURE_ENDPOINT_URL: AZURE,
  AZURE_SUBSCRIPTION_ID: SUBSCRIPTION,
  GCP_ENDPOINT_URL: GCP,
  GCP_PROJECT_ID: GCP_PROJECT,
  GOOGLE_CLOUD_PROJECT: GCP_PROJECT,
  GCP_REGION,
};

const say = (line: string): void => void process.stdout.write(`front-door: ${line}\n`);

class Refusal extends Error {}

/**
 * The azure estate's set plan, planned through chant's choudoufuPlanSet Op
 * activity (chant#4483, behold#1017): a one-step Op, run in this process with
 * runOpLocally over the activities `loadActivities(["terraform"])` resolves,
 * so the plan goes through the same activity, contract and step record an Op
 * file's step would. The step's result is read off the activity as it
 * returns, because a step record carries no output.
 *
 * Published chant 0.124.52's terraform lexicon contributes no
 * choudoufuPlanSet activity, so with that chant (what `npm ci` here installs
 * while behold's CHANT_RELEASE is unreleased) the same function is called
 * directly, as before. Both answer the same ChoudoufuPlanSetResult.
 */
async function planAzureSet(): Promise<ChoudoufuPlanSetResult> {
  const { activity, loadActivities, runOpLocally } = await import("@intentius/chant/op");
  const activities = await loadActivities(["terraform"]);
  const planSet = activities.get("choudoufuPlanSet");
  if (!planSet) {
    say("azure: this chant's terraform lexicon has no choudoufuPlanSet Op activity (chant#4483), so the plan set is called directly");
    return choudoufuPlanSet(AZURE_ROOT);
  }
  let planned: ChoudoufuPlanSetResult | undefined;
  activities.set("choudoufuPlanSet", async (args, signal) => {
    planned = (await planSet(args, signal)) as ChoudoufuPlanSetResult;
    return planned;
  });
  const op: OpConfig = {
    name: "front-door-azure-plan",
    overview: "Plan the azure estate as a one-root choudoufu set (live-plan-set), writing nothing to floci-az",
    phases: [{ name: "Plan azure", steps: [activity("choudoufuPlanSet", { ...AZURE_ROOT }, { profile: "longInfra", id: "azure" })] }],
  };
  const profiles: Parameters<typeof runOpLocally>[2] = { longInfra: { timeout: "15m", retry: { maximumAttempts: 1 } } };
  try {
    await runOpLocally(op, activities, profiles);
  } catch (e) {
    throw new Refusal(`azure: the choudoufuPlanSet step failed: ${(e as Error).message}`);
  }
  if (!planned) throw new Refusal("azure: the choudoufuPlanSet step ran but returned no set plan");
  return planned;
}

/** A refusal because a part's plan is not the approved one: chant's planMoved exit code. */
class PlanMoved extends Refusal {
  readonly planMoved = true;
}

// ---------------------------------------------------------------------------
// Build

function build(member: "dns" | "gcp"): string {
  const out = join(WORK, member === "gcp" ? "gcp.yaml" : `${member}.json`);
  mkdirSync(WORK, { recursive: true });
  // dns lists terraform and pulumi too, for its member-outputs components,
  // and the terraform lexicon writes the azure root it names into the same
  // build after the template. Only the aws lexicon's template is wanted.
  const lexicon = member === "dns" ? ["--lexicon", "aws"] : [];
  const r = spawnSync(CHANT, ["build", "src", ...lexicon, "-o", out], { cwd: join(ROOT, member), env: childEnv, encoding: "utf8" });
  if (r.status !== 0) throw new Refusal(`chant build failed in ${member}:\n${r.stderr || r.stdout}`);
  return out;
}

/** A copy of a CloudFormation template whose parameters default to `values`,
 * so `awsApply` (which passes no parameters) creates the stack with them. */
function withDefaults(template: string, values: Record<string, string>): string {
  const doc = JSON.parse(readFileSync(template, "utf8")) as { Parameters?: Record<string, Record<string, unknown>> };
  for (const [name, value] of Object.entries(values)) {
    const p = doc.Parameters?.[name];
    if (!p) throw new Refusal(`${template} declares no parameter ${name}`);
    p.Default = value;
  }
  const out = template.replace(/\.json$/, ".params.json");
  writeFileSync(out, JSON.stringify(doc, null, 2));
  return out;
}

// ---------------------------------------------------------------------------
// Where the checkers connect

/** An emulator container's address on Docker's network, which floci's
 * checkers (in their own container) can reach. */
function containerAddress(name: string): string {
  let ip = "";
  try {
    ip = execFileSync("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", name], { encoding: "utf8" }).trim().split(/\s+/)[0] ?? "";
  } catch {
    throw new Refusal(`no container named ${name}: boot the emulators first (behold demo three-cloud does)`);
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Refusal(`container ${name} has no IPv4 address on a Docker network`);
  return ip;
}

// ---------------------------------------------------------------------------
// The floci-az endpoint lock, for every choudoufu call

/**
 * The credential and endpoint variables azurerm, its SDK and the Azure CLI
 * would read from the operator's shell, which no choudoufu call here keeps:
 * choudoufu's FLOCI_AZ_SCRUBBED (live/e2e/lib/floci-az.sh), as it stands.
 * Any of them could put a credential ahead of the client secret the provider
 * block states, or move the authority.
 */
const AZURE_SCRUBBED = `
ARM_CLIENT_CERTIFICATE ARM_CLIENT_CERTIFICATE_PATH ARM_CLIENT_CERTIFICATE_PASSWORD
ARM_CLIENT_ID_FILE_PATH ARM_CLIENT_SECRET_FILE_PATH
ARM_OIDC_TOKEN ARM_OIDC_TOKEN_FILE_PATH ARM_OIDC_REQUEST_TOKEN ARM_OIDC_REQUEST_URL
ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID ARM_OIDC_AZURE_SERVICE_CONNECTION_ID AZURESUBSCRIPTION_SERVICE_CONNECTION_ID
ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL SYSTEM_ACCESSTOKEN SYSTEM_OIDCREQUESTURI
ARM_MSI_ENDPOINT ARM_MSI_API_VERSION ARM_AUXILIARY_TENANT_IDS ARM_PARTNER_ID
ARM_ACCESS_KEY ARM_SAS_TOKEN ARM_USE_AZUREAD ARM_STORAGE_USE_AZUREAD
AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_CLIENT_SECRET AZURE_CLIENT_CERTIFICATE_PATH
AZURE_CLIENT_CERTIFICATE_PASSWORD AZURE_CLIENT_SEND_CERTIFICATE_CHAIN AZURE_USERNAME AZURE_PASSWORD
AZURE_FEDERATED_TOKEN_FILE AZURE_AUTHORITY_HOST AZURE_REGIONAL_AUTHORITY_NAME
AZURE_ADDITIONALLY_ALLOWED_TENANTS AZURE_TOKEN_CREDENTIALS AZURE_SUBSCRIPTION_ID
AZURE_POD_IDENTITY_AUTHORITY_HOST IDENTITY_ENDPOINT IDENTITY_HEADER IDENTITY_SERVER_THUMBPRINT
IMDS_ENDPOINT MSI_ENDPOINT MSI_SECRET
`.split(/\s+/).filter(Boolean);

/**
 * Aim every choudoufu child at floci-az and nothing else: this process's
 * environment is what the terraform lexicon's activities hand choudoufu, so
 * it is locked here, the way choudoufu's floci_az_provider_env locks a shell.
 * The provider block already states each argument, which beats the
 * environment; this covers what a block cannot say. CHOUDOUFU_BIN, when set,
 * is put on PATH as `choudoufu`, the binary chant.config.json names.
 *
 * TLS: azurerm reaches floci-az over https. On Linux floci-az's own CA is
 * fetched and added to the bundle SSL_CERT_FILE names. Go on macOS trusts
 * only the keychain, so there the certificate scripts/emulators-up.sh mounts
 * is the one choudoufu's scripts/floci-az-mac-cert.sh made and the operator
 * trusted once.
 */
async function lockAzureEnv(): Promise<void> {
  for (const v of AZURE_SCRUBBED) delete process.env[v];
  const noLogin = join(WORK, "azure-config-no-login");
  mkdirSync(noLogin, { recursive: true });
  Object.assign(process.env, {
    AZURE_CONFIG_DIR: noLogin,
    ARM_SUBSCRIPTION_ID: SUBSCRIPTION,
    ARM_TENANT_ID: TENANT,
    ARM_CLIENT_ID: CLIENT,
    ARM_CLIENT_SECRET: "floci-az-fake-secret",
    ARM_USE_CLI: "false",
    ARM_USE_MSI: "false",
    ARM_USE_OIDC: "false",
    ARM_USE_AKS_WORKLOAD_IDENTITY: "false",
    ARM_METADATA_HOSTNAME: AZURE_HOST,
    ARM_METADATA_HOST: AZURE_HOST,
    ARM_RESOURCE_PROVIDER_REGISTRATIONS: "none",
    ARM_DISABLE_TERRAFORM_PARTNER_ID: "true",
    TF_VAR_floci_az_host: AZURE_HOST,
  });
  const bin = process.env.CHOUDOUFU_BIN;
  if (bin) {
    if (!existsSync(bin)) throw new Refusal(`CHOUDOUFU_BIN names ${bin}, which does not exist`);
    const dir = join(WORK, "bin");
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, "choudoufu"), { force: true });
    symlinkSync(resolve(bin), join(dir, "choudoufu"));
    if (!process.env.PATH?.startsWith(`${dir}:`)) process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  }
  if (process.platform === "darwin" || process.env.SSL_CERT_FILE?.endsWith("ca-bundle-with-floci-az.pem")) return;
  const ca = await fetch(`http://${AZURE_HOST}/_floci/tls-cert`).then((r) => (r.ok ? r.text() : ""), () => "");
  if (!ca.includes("BEGIN CERTIFICATE")) throw new Refusal(`azure: floci-az at ${AZURE_HOST} served no TLS certificate at /_floci/tls-cert; scripts/emulators-up.sh starts it with TLS on`);
  const system = [process.env.SSL_CERT_FILE, "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem"].find((f) => f && existsSync(f));
  if (!system) throw new Refusal("azure: found no system CA bundle to add floci-az's CA to");
  const bundle = join(WORK, "ca-bundle-with-floci-az.pem");
  writeFileSync(bundle, `${readFileSync(system, "utf8")}\n${ca}`);
  process.env.SSL_CERT_FILE = bundle;
}

// ---------------------------------------------------------------------------
// The floci lock, for every plunge call

/** The aws program's directory, where Pulumi.yaml names plunge's backend. */
const AWS_DIR = join(ROOT, "aws");
/** The `plunge stack export` chant reads the aws member's graph from (chant-lexicon-pulumi's PULUMI_EXPORT_FILE). */
const AWS_EXPORT = "stack-export.json";

/**
 * Variables from the operator's shell that could point plunge at a real
 * account or a Pulumi Cloud backend, or put a credential ahead of floci's
 * fake key pair. None of them is handed to plunge.
 */
const AWS_SCRUBBED = `
AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SESSION_TOKEN AWS_SECURITY_TOKEN AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE
AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_AUTHORIZATION_TOKEN
AWS_SHARED_CREDENTIALS_FILE AWS_CONFIG_FILE
PULUMI_ACCESS_TOKEN PULUMI_BACKEND_URL PULUMI_API
`.split(/\s+/).filter(Boolean);

/**
 * Aim every plunge child at floci and nothing else, the way lockAzureEnv aims
 * choudoufu at floci-az: this process's environment is what the pulumi
 * lexicon's runner hands plunge (defaultPlungeRunner runs `plunge` from
 * PATH), so it is locked here. The program refuses an endpoint off this
 * machine itself (aws/index.ts); this refuses before plunge starts. An empty
 * passphrase is the stack's secrets provider: the program has no secrets.
 * PLUNGE_BIN, when set, is put on PATH as `plunge`.
 */
function lockAwsEnv(): void {
  const host = new URL(AWS).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) throw new Refusal(`aws: AWS_ENDPOINT_URL names ${AWS}, which is not on this machine; the aws program runs only against floci here`);
  for (const v of AWS_SCRUBBED) delete process.env[v];
  Object.assign(process.env, {
    AWS_ENDPOINT_URL: AWS,
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_REGION: "us-east-1",
    AWS_EC2_METADATA_DISABLED: "true",
    PULUMI_CONFIG_PASSPHRASE: process.env.PULUMI_CONFIG_PASSPHRASE ?? "",
    PULUMI_SKIP_UPDATE_CHECK: "true",
  });
  const bin = process.env.PLUNGE_BIN;
  if (bin) {
    if (!existsSync(bin)) throw new Refusal(`PLUNGE_BIN names ${bin}, which does not exist`);
    const dir = join(WORK, "bin");
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, "plunge"), { force: true });
    symlinkSync(resolve(bin), join(dir, "plunge"));
    if (!process.env.PATH?.startsWith(`${dir}:`)) process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  }
}

/** `plunge <args>` in `cwd` under the floci lock; its stdout, or a refusal with what it said. */
function plunge(args: string[], cwd: string = AWS_DIR, opts: { show?: boolean } = {}): string {
  const r = spawnSync("plunge", args, { cwd, env: process.env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: opts.show ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"] });
  if (r.error) throw new Refusal(`aws: plunge did not start (${r.error.message}); put plunge on PATH or name a build with PLUNGE_BIN`);
  if (r.status !== 0) throw new Refusal(`aws: plunge ${args.join(" ")} failed (exit ${r.status})${opts.show ? "" : `:\n${(r.stderr || r.stdout || "").trim().split("\n").slice(-8).join("\n")}`}`);
  return r.stdout ?? "";
}

/**
 * The aws program ready to run: its packages installed, the backend
 * directory Pulumi.yaml names made, and the stack named after the
 * environment selected (created on the first run, which writes only plunge's
 * own state under aws/ and the stack file's encryption salt).
 */
function awsStack(cwd: string = AWS_DIR): void {
  lockAwsEnv();
  if (!existsSync(join(cwd, "node_modules", "@pulumi", "aws"))) {
    say("aws: npm install in aws/ (the program's @pulumi/aws and @pulumi/pulumi)");
    const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd, stdio: "inherit" });
    if (r.status !== 0) throw new Refusal(`aws: npm install in ${relative(ROOT, cwd) || "."} failed (exit ${r.status})`);
  }
  mkdirSync(join(cwd, ".plunge"), { recursive: true });
  plunge(["stack", "select", "--create", "--secrets-provider", "passphrase", ENV], cwd);
}

/** The aws stack's applied outputs (`plunge stack output --json --show-secrets=false`). */
function awsOutputs(cwd: string = AWS_DIR): Record<string, unknown> {
  lockAwsEnv();
  const text = plunge(["stack", "output", "--json", "--show-secrets=false", "--stack", ENV], cwd);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Refusal(`aws: plunge stack output printed no JSON: ${text.slice(0, 300)}`);
  }
}

/** The aws load balancer's hostname, or why there is none. */
function awsEndpoint(cwd: string = AWS_DIR): { endpoint: string } | { refused: string } {
  try {
    const out = awsOutputs(cwd);
    return typeof out.awsEndpoint === "string" && out.awsEndpoint ? { endpoint: out.awsEndpoint } : { refused: "the stack has no awsEndpoint output" };
  } catch (e) {
    return { refused: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Plan: one change set over the four members

/** `chant lifecycle plan <env> --json` in a chant member, parsed. */
function lifecyclePlan(member: string): LifecycleChangeSet {
  const r = spawnSync(CHANT, ["lifecycle", "plan", ENV, "--json"], { cwd: join(ROOT, member), env: childEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Refusal(`${member}: chant lifecycle plan ${ENV} failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout) as LifecycleChangeSet;
}

/**
 * The change set a run over the whole workspace would approve, one part per
 * engine: a chant part for each of dns and gcp, the azure estate's choudoufu
 * part from choudoufuPlanSet (choudoufu's root digest as its nativeDigest),
 * and the aws program's pulumi part from `plunge preview --json`
 * (previewPulumiMember, which reads it with pulumiPreviewPart, the checked-in
 * stack-export.json as the last deployment), composed under one document
 * digest. Written to `out`. Reads only: nothing applies. The aws stack is
 * selected first, and created on a first run (awsStack), which writes
 * plunge's own state under aws/ and nothing on floci.
 */
export async function plan(out: string): Promise<ChangeSetDocument> {
  const parts: ChangeSetPart[] = [];
  for (const member of ["dns", "gcp"]) {
    say(`${member}: chant lifecycle plan ${ENV}`);
    parts.push(lifecyclePlanPart({ member, plan: lifecyclePlan(member) }));
  }
  await lockAzureEnv();
  say(`azure: choudoufu live-plan-set over the azure estate, on floci-az at ${AZURE_HOST}`);
  parts.push((await planAzureSet()).changeSet);
  awsStack();
  say(`aws: plunge preview --json --stack ${ENV}, on floci at ${AWS}`);
  const { previewPulumiMember } = await pulumiRun();
  parts.push(await previewPulumiMember({ member: "aws", dir: AWS_DIR, stack: ENV }));
  const chant = (JSON.parse(readFileSync(join(ROOT, "node_modules", "@intentius", "chant", "package.json"), "utf8")) as { version?: string }).version;
  const doc = composeChangeSet(parts, chant ? { chant } : {});
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${JSON.stringify(doc, null, 2)}\n`);
  for (const m of doc.members) {
    const counts = doc.summary.byMember[m.member] ?? {};
    const changes = Object.entries(counts).filter(([action, n]) => n && action !== "no-op").map(([action, n]) => `${action} ${n}`).join(", ");
    say(`plan: ${m.member} (${m.planner}) ${m.status}${m.status === "failed" ? `: ${m.error}` : `, ${changes || "no changes"}`}`);
  }
  say(`plan: change set ${doc.digest} over ${doc.members.length} members, written to ${relative(process.cwd(), resolve(out)) || out}`);
  return doc;
}

/** One part of an approved set whose plan is not the one planned now. */
export interface MovedPart {
  member: string;
  planner: string;
  /** The approved part's plan digest, and the fresh one's (null for a failed plan). */
  approved: string | null;
  fresh: string | null;
  reason: string;
}

/**
 * The parts of `approved` that `fresh` does not plan the same way. A part
 * stands when it is in both, planned, under the same plan digest. For any
 * other the reason is chant's own (`planCoveredBy`, the words a pull
 * request's apply gives a member whose plan moved), or the two digests when
 * chant has none. The set is refused when the documents' digests differ,
 * which this lists the parts of; a document digest that moved with every
 * part's plan digest the same (a hole, an entry) is its own line.
 */
export function movedParts(approved: ChangeSetDocument, fresh: ChangeSetDocument): MovedPart[] {
  const names = [...new Set([...approved.members, ...fresh.members].map((m) => m.member))].sort();
  const out: MovedPart[] = [];
  for (const name of names) {
    const was = approved.members.find((m) => m.member === name);
    const now = fresh.members.find((m) => m.member === name);
    const digests = { approved: was?.planDigest ?? null, fresh: now?.planDigest ?? null };
    const planner = (now ?? was)!.planner;
    if (!now) {
      out.push({ member: name, planner, ...digests, reason: `${name} is in the approved set and was not planned now` });
      continue;
    }
    if (was && was.status === "planned" && now.status === "planned" && was.planDigest !== null && now.planDigest === was.planDigest) continue;
    const reason = planCoveredBy(approved, fresh, name) ?? `${name}'s plan digest is ${digests.fresh ?? "none"}, and ${digests.approved ?? "none"} was approved`;
    out.push({ member: name, planner, ...digests, reason });
  }
  return out;
}

/** What `apply --change-set` decided, written to .front-door/apply-verdict.json before anything applies. */
interface ApplyVerdict {
  verdict: "refused" | "applying" | "applied";
  approved: string;
  fresh?: string;
  moved?: MovedPart[];
  reason?: string;
}

function writeVerdict(v: ApplyVerdict): void {
  mkdirSync(WORK, { recursive: true });
  writeFileSync(join(WORK, "apply-verdict.json"), `${JSON.stringify(v, null, 2)}\n`);
}

/**
 * Apply the set in `file`, or refuse it whole. The document's own digest is
 * checked first (verifyChangeSetDigest: an edited document binds nothing),
 * then all four members are planned again (`plan`), and when the fresh
 * document's digest is not the approved one the whole set is refused, every
 * moved part named, before any member applies: one gate binds every part, so
 * a changed plan in any part, chant, choudoufu or pulumi, refuses the set.
 * The refusal exits with chant's planMoved code (3). Only a set that still
 * stands is applied (`apply`).
 */
export async function applyApproved(file: string): Promise<void> {
  let approved: ChangeSetDocument;
  try {
    approved = JSON.parse(readFileSync(resolve(file), "utf8")) as ChangeSetDocument;
  } catch (e) {
    throw new Refusal(`apply: ${file} is not a change-set document: ${(e as Error).message}`);
  }
  if (!verifyChangeSetDigest(approved)) {
    const reason = `the document's digest ${approved.digest} is not the one its parts give: it was changed after it was composed`;
    writeVerdict({ verdict: "refused", approved: approved.digest, reason });
    throw new PlanMoved(`apply: refused, nothing applied: ${reason}`);
  }
  const failed = approved.members.filter((m) => m.status !== "planned");
  if (failed.length) {
    const reason = `the approved set has parts that did not plan: ${failed.map((m) => `${m.member} (${m.planner}) ${m.status}${m.error ? `: ${m.error}` : ""}`).join("; ")}`;
    writeVerdict({ verdict: "refused", approved: approved.digest, reason });
    throw new Refusal(`apply: refused, nothing applied: ${reason}`);
  }
  say(`apply: planning the four members again, to check the set ${approved.digest} still stands`);
  const fresh = await plan(join(WORK, "change-set.fresh.json"));
  if (fresh.digest !== approved.digest) {
    const moved = movedParts(approved, fresh);
    const reason = moved.length
      ? moved.map((m) => `${m.member} (${m.planner}): ${m.reason}`).join("; ")
      : `the document digest is ${fresh.digest} now, with every part's plan digest the same (a hole or an entry moved)`;
    writeVerdict({ verdict: "refused", approved: approved.digest, fresh: fresh.digest, moved, reason });
    for (const m of moved) say(`apply: ${m.member} (${m.planner}) moved: ${m.reason}`);
    throw new PlanMoved(`apply: the change set ${approved.digest} is refused whole, nothing applied: it plans as ${fresh.digest} now`);
  }
  writeVerdict({ verdict: "applying", approved: approved.digest, fresh: fresh.digest });
  say(`apply: the set ${approved.digest} stands, every part as approved; applying`);
  await apply();
  writeVerdict({ verdict: "applied", approved: approved.digest, fresh: fresh.digest });
}

/**
 * dns's pull-request plan of the change from `base` to HEAD, as dns's own
 * pipeline would run it: `chant components pr-plan --member dns` in dns,
 * with no status posted. A change under azure/ names the azure component
 * (dns's `terraform.roots.azure`), so records is planned against what
 * azure's plan says azureEndpoint will be. Under the floci-az lock, since
 * the azure component's plan runs `choudoufu live-plan-set`, and the floci
 * lock, since the aws component reads the stack with `plunge stack output`
 * (or `plunge preview` when the change names aws). Reads only.
 */
export async function prPlanDns(base: string, out: string): Promise<void> {
  await lockAzureEnv();
  awsStack();
  mkdirSync(resolve(out), { recursive: true });
  say(`dns: chant components pr-plan --base ${base} --member dns --env ${ENV}`);
  const r = spawnSync(CHANT, ["components", "pr-plan", "--base", base, "--pr", "1", "--env", ENV, "--member", "dns", "--no-status", "--output", resolve(out)], {
    cwd: join(ROOT, "dns"),
    env: lockedChildEnv(),
    stdio: "inherit",
  });
  // The report says what was planned; a member that failed to plan is in it.
  if (!existsSync(join(resolve(out), "pr-plan.json"))) throw new Refusal(`dns: chant components pr-plan wrote no report (exit ${r.status})`);
}

// ---------------------------------------------------------------------------
// Apply

async function applyGcp(): Promise<string> {
  const manifest = build("gcp");
  say(`gcp: applying ${manifest} to ${GCP} (project ${GCP_PROJECT})`);
  await gcpApply({ manifestPath: manifest, endpoint: GCP, project: GCP_PROJECT });
  // Config Connector YAML has no outputs, so the build's `gcpEndpoint` output
  // is not written (chant warns). The URI is read from the service instead.
  // The service's location is the manifest's, or us-central1 where gcpApply
  // puts a service that names none.
  // The RunService's own location: the load balancer's kinds say `global`.
  const location = /kind:\s*RunService[\s\S]*?^\s+location:\s*['"]?([a-z0-9-]+)/m.exec(readFileSync(manifest, "utf8"))?.[1] ?? "us-central1";
  const svc = (await getJson(`${GCP}/v2/projects/${GCP_PROJECT}/locations/${location}/services/three-cloud-site`)) as { uri?: string };
  if (!svc.uri) throw new Refusal(`gcp: the Cloud Run service three-cloud-site has no uri yet (${JSON.stringify(svc).slice(0, 300)})`);
  say(`gcp: Cloud Run answers as ${new URL(svc.uri).hostname}`);
  // Route 53 points at the load balancer's address. A chant older than
  // 0.124.35 skips the load balancer kinds ("no mapper"), and then there is
  // no address: the record gets one nothing answers on (192.0.2.1, kept for
  // documentation by RFC 5737), and the page shows GCP failing its check.
  const addr = (await fetch(`${GCP}/compute/v1/projects/${GCP_PROJECT}/global/addresses/three-cloud-ip`).then((r) => (r.ok ? r.json() : {}))) as { address?: string };
  if (!addr.address) {
    say("gcp: the load balancer was NOT APPLIED (it needs chant 0.124.35 or newer), so the gcp record has nothing behind it");
    return "192.0.2.1";
  }
  return addr.address;
}

/** The azure estate: plan it as a one-root set, apply exactly that set, read its endpoint. */
async function applyAzure(): Promise<string> {
  await lockAzureEnv();
  say(`azure: choudoufu live-plan-set over the azure estate, on floci-az at ${AZURE_HOST}`);
  const set = await planAzureSet();
  say(`azure: ${set.changed ? "applying" : "no changes in"} set ${set.setDigest} with live-wave-apply`);
  const applied = await choudoufuWaveApply({ ...AZURE_ROOT, planSetFile: set.planSetFile, setDigest: set.setDigest });
  if (!applied.landed) throw new Refusal(`azure: ${applied.message}`);
  const { azureEndpoint } = await terraformOutputs(AZURE_ROOT);
  if (typeof azureEndpoint !== "string" || !azureEndpoint) throw new Refusal("azure: the estate has no azureEndpoint output after its apply");
  await azureOn();
  return azureEndpoint;
}

/** A run before this one turned Azure off, and applying the same app again
 * leaves its revision inactive: turn the newest one back on. */
async function azureOn(): Promise<void> {
  const list = await getJson(`${appUrl()}/revisions?api-version=2024-03-01`);
  const revisions = (list.value ?? []) as Array<{ name: string; properties?: { active?: boolean; createdTime?: string } }>;
  if (!revisions.length || revisions.some((r) => r.properties?.active !== false)) return;
  const newest = [...revisions].sort((a, b) => (a.properties?.createdTime ?? a.name).localeCompare(b.properties?.createdTime ?? b.name)).at(-1)!;
  const res = await fetch(`${appUrl()}/revisions/${newest.name}/activate?api-version=2024-03-01`, { method: "POST" });
  if (!res.ok) throw new Refusal(`azure: activating revision ${newest.name} answered ${res.status}: ${await res.text()}`);
  say(`azure: revision ${newest.name} activated again`);
}

/**
 * The aws program: `plunge up` on the stack named after the environment,
 * then `plunge stack export` to aws/stack-export.json, which is what chant
 * reads the member's graph from (the graph read never runs the program).
 * Returns the load balancer's hostname, the stack's awsEndpoint output.
 * Unlike the CloudFormation stack it replaces, a failed `up` stops the run:
 * dns reads awsEndpoint from the stack, so there is nothing for it to point
 * at.
 */
async function applyAws(): Promise<string> {
  awsStack();
  say(`aws: plunge up --stack ${ENV}, on floci at ${AWS}`);
  plunge(["up", "--yes", "--non-interactive", "--skip-preview", "--stack", ENV], AWS_DIR, { show: true });
  plunge(["stack", "export", "--stack", ENV, "--file", AWS_EXPORT]);
  say(`aws: ${relative(process.cwd(), join(AWS_DIR, AWS_EXPORT)) || AWS_EXPORT} written, the export chant reads the member's graph from`);
  const aws = awsEndpoint();
  if ("refused" in aws) throw new Refusal(`aws: ${aws.refused}`);
  return aws.endpoint;
}

/** Where floci's checkers connect for one cloud's check, as Route 53 does
 * for a check with an IPAddress: to the address and port given, sending the
 * endpoint as the Host header. */
interface Probe {
  address: string;
  port: number;
}

/**
 * A copy of the dns template whose checks connect to the emulators. The
 * source declares checks as they are on AWS, where the checkers resolve each
 * endpoint; on the emulators nothing outside Docker resolves a floci-az or
 * floci-gcp hostname, so each check is given the emulator container's address
 * and port (lex00/floci#259). This is the one place the deployed dns stack
 * differs from its source, and behold shows those two fields as drift.
 */
function withProbes(template: string, probes: Record<string, Probe>): void {
  const doc = JSON.parse(readFileSync(template, "utf8")) as { Resources: Record<string, { Properties: { HealthCheckConfig: Record<string, unknown> } }> };
  for (const [check, probe] of Object.entries(probes)) {
    const cfg = doc.Resources[check]?.Properties?.HealthCheckConfig;
    if (!cfg) throw new Refusal(`${template} declares no health check ${check}`);
    cfg.IPAddress = probe.address;
    cfg.Port = probe.port;
  }
  writeFileSync(template, JSON.stringify(doc, null, 2));
}

/** The dns template, its parameters in `endpoints` defaulted and its checks pointed at `probes`. */
function dnsTemplate(endpoints: Record<string, string>, probes: Record<string, Probe>): string {
  const params = withDefaults(build("dns"), endpoints);
  withProbes(params, probes);
  return params;
}

async function applyDns(endpoints: Record<string, string>, probes: Record<string, Probe>): Promise<void> {
  const params = dnsTemplate(endpoints, probes);
  // The stack named after the environment, where chant's live read looks for a single-stack project.
  say(`dns: applying ${params} to ${AWS} as stack ${ENV}`);
  await awsApply({ templatePath: params, stackName: ENV, endpoint: AWS, timeoutMs: 180_000 });
}

export async function apply(): Promise<void> {
  workspaceCopy();
  runComponent("gcp", "site");
  // The azure estate is no chant component: choudoufu applies it (applyAzure,
  // which also turns a revision a run before this one left off back on).
  say(`azure: web answers as ${await applyAzure()}`);
  // The aws program is no chant component either: plunge applies it, in the
  // workspace itself, and the copy links to its state (workspaceCopy). The
  // copy's aws/ is another project directory to plunge, so the stack is
  // selected there too, for the aws component's `plunge stack output`.
  say(`aws: web answers as ${await applyAws()}`);
  plunge(["stack", "select", ENV], join(RUN, "aws"));
  // dns's azure and aws components read the estate's outputs through
  // choudoufu and the stack's through plunge, so they run under both locks,
  // and before records, which reads them.
  await lockAzureEnv();
  lockAwsEnv();
  runComponent("dns", "azure,aws,records", lockedChildEnv());
  // Before anything is turned off, the check on Azure has to pass: that is
  // what shows the checkers reach floci-az at all.
  await waitFor("healthy");
}

/** A git, as the copy's commits and pushes need it, with a test identity. */
function git(args: string[], cwd: string): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "three-cloud demo", GIT_AUTHOR_EMAIL: "demo@three-cloud.test", GIT_COMMITTER_NAME: "three-cloud demo", GIT_COMMITTER_EMAIL: "demo@three-cloud.test" } });
  if (r.status !== 0) throw new Refusal(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

/** A fresh copy of the workspace, committed, with a bare repository beside it as its origin. */
function workspaceCopy(): void {
  rmSync(RUN, { recursive: true, force: true });
  rmSync(REMOTE, { recursive: true, force: true });
  const skip = /(^|[/\\])(node_modules|export|\.front-door|dist|\.git)([/\\]|$)/;
  // Entry by entry: a directory can't be copied into its own .front-door.
  // The root's .chant holds choudoufuPlanSet's set plan documents, which
  // belong to the workspace, not the copy.
  mkdirSync(RUN, { recursive: true });
  for (const e of readdirSync(ROOT)) {
    if (!skip.test(e) && e !== ".chant") cpSync(join(ROOT, e), join(RUN, e), { recursive: true, filter: (src) => !skip.test(relative(ROOT, src)) && !LINKED_STATE.includes(relative(ROOT, src)) });
  }
  symlinkSync(join(ROOT, "node_modules"), join(RUN, "node_modules"));
  // The azure estate's schemas, lock file and records, and the aws program's
  // plunge backend, stack file, export and packages, linked rather than
  // copied: behold reads both members in the copy, the copy's dns reads
  // their outputs, and choudoufu and plunge apply them here. A link may
  // point at what the first apply has yet to write.
  mkdirSync(join(AWS_DIR, ".plunge"), { recursive: true });
  for (const p of LINKED_STATE) symlinkSync(join(ROOT, p), join(RUN, p));
  git(["init", "-q", "-b", "main"], RUN);
  git(["add", "-A"], RUN);
  git(["commit", "-q", "-m", "three-cloud"], RUN);
  git(["init", "-q", "--bare", REMOTE], WORK);
  git(["remote", "add", "origin", REMOTE], RUN);
  git(["push", "-q", "origin", "main"], RUN);
  say(`run: the workspace copied to ${relative(ROOT, RUN)}, its releases recorded on ${relative(ROOT, REMOTE)}`);
}

/** What choudoufu keeps beside the azure estate, which the copy links to (workspaceCopy). */
const AZURE_STATE = [".terraform", ".terraform.lock.hcl", ".tofu-records"].map((f) => join("azure", f));
/** What plunge keeps beside the aws program, and its packages, which the copy links to too. */
const AWS_STATE = [".plunge", "Pulumi.local.yaml", "stack-export.json", "node_modules"].map((f) => join("aws", f));
const LINKED_STATE = [...AZURE_STATE, ...AWS_STATE];

/**
 * childEnv with this process's environment as lockAzureEnv left it, for a
 * chant child that starts choudoufu: the variables the lock removed stay
 * removed, and the ones it set win.
 */
function lockedChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...childEnv, ...process.env };
  for (const v of AZURE_SCRUBBED) if (!(v in process.env)) delete env[v];
  return env;
}

/** One member's components (a name or a comma list), through chant's own deploy steps, against the emulators. */
function runComponent(member: string, component: string, env: NodeJS.ProcessEnv = childEnv): void {
  say(`${member}: chant run --components ${component} --env ${ENV}`);
  const r = spawnSync(join(RUN, "node_modules", ".bin", "chant"), ["run", "--components", component, "--env", ENV], {
    cwd: join(RUN, member),
    env: { ...env, USER: "three-cloud-demo", GIT_AUTHOR_NAME: "three-cloud demo", GIT_AUTHOR_EMAIL: "demo@three-cloud.test", GIT_COMMITTER_NAME: "three-cloud demo", GIT_COMMITTER_EMAIL: "demo@three-cloud.test" },
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Refusal(`${member}: the ${component} component did not apply (exit ${r.status})`);
}

/**
 * The dns records component's Build step: the template its cfn-deploy step
 * applies, at dns/dist/dns.json. gcpEndpoint defaults to what the gcp member
 * has applied; azureEndpoint and awsEndpoint have no default, since the step
 * passes them from the azure and aws components' outputs. The checks point
 * at the emulators, as in applyFrontDoor; awsCheck at floci only when the aws
 * stack has an endpoint to probe.
 */
async function buildDns(): Promise<void> {
  const aws = awsEndpoint(join(ROOT, "aws"));
  if ("refused" in aws) say(`aws: no awsEndpoint on the stack yet, so the aws check probes nothing that answers: ${aws.refused}`);
  const gcp = await gcpAddress();
  const params = dnsTemplate(
    { gcpEndpoint: gcp },
    {
      awsCheck: { address: "endpoint" in aws ? containerAddress(CONTAINERS.aws) : "192.0.2.1", port: 80 },
      azureCheck: { address: containerAddress(CONTAINERS.azure), port: 4577 },
      gcpCheck: { address: gcp === "192.0.2.1" ? gcp : containerAddress(CONTAINERS.gcp), port: 80 },
    },
  );
  const dist = join(ROOT, "dns", "dist");
  mkdirSync(dist, { recursive: true });
  cpSync(params, join(dist, "dns.json"));
  say(`dns: ${relative(process.cwd(), join(dist, "dns.json")) || "dist/dns.json"} built, azureEndpoint and awsEndpoint left to the azure and aws components' outputs`);
}

/** The gcp load balancer's address, or 192.0.2.1 (RFC 5737) when there is none. */
async function gcpAddress(): Promise<string> {
  const addr = (await fetch(`${GCP}/compute/v1/projects/${GCP_PROJECT}/global/addresses/three-cloud-ip`).then((r) => (r.ok ? r.json() : {}), () => ({}))) as { address?: string };
  return addr.address ?? "192.0.2.1";
}

/** The dns member, with the three endpoints the other members published. */
async function applyFrontDoor(gcp: string, azure: string, aws: { endpoint: string } | { refused: string }): Promise<void> {
  // An aws stack that doesn't apply leaves its record pointing at a name that
  // doesn't resolve and its check probing an address nothing answers on
  // (192.0.2.1, kept for documentation by RFC 5737), so the page shows AWS
  // failing and the rest still runs.
  if ("refused" in aws) say(`aws: NOT APPLIED, so the aws record has nothing behind it and its check fails: ${aws.refused}`);
  else say(`aws: web answers as ${aws.endpoint}`);
  await applyDns(
    {
      awsEndpoint: "endpoint" in aws ? aws.endpoint : "aws.three-cloud.invalid",
      azureEndpoint: azure,
      gcpEndpoint: gcp,
    },
    {
      // floci runs a load balancer's listener on the listener's own port (80)
      // in its container, not behind :4566.
      awsCheck: { address: "endpoint" in aws ? containerAddress(CONTAINERS.aws) : "192.0.2.1", port: 80 },
      // floci-az serves every app on its own port, by Host header.
      azureCheck: { address: containerAddress(CONTAINERS.azure), port: 4577 },
      // floci-gcp opens a forwarding rule's port (80) in its container.
      gcpCheck: { address: gcp === "192.0.2.1" ? gcp : containerAddress(CONTAINERS.gcp), port: 80 },
    },
  );
  say("dns: applied");
}

/** The dns member alone, outside chant, reading the three endpoints from what is already applied. */
async function applyFrontDoorFromLive(): Promise<void> {
  const aws = awsEndpoint();
  const app = await getJson(`${appUrl()}?api-version=2024-03-01`);
  const azure = (app.properties as { configuration?: { ingress?: { fqdn?: string } } } | undefined)?.configuration?.ingress?.fqdn;
  if (!azure) throw new Refusal("azure: the container app web has no ingress fqdn; apply the azure member first");
  await applyFrontDoor(await gcpAddress(), azure, aws);
}

// ---------------------------------------------------------------------------
// Turn Azure off

function appUrl(): string {
  return `${AZURE}/subscriptions/${SUBSCRIPTION}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/containerApps/web`;
}

export async function azureOff(): Promise<void> {
  const list = await getJson(`${appUrl()}/revisions?api-version=2024-03-01`);
  const active = ((list.value ?? []) as Array<{ name: string; properties?: { active?: boolean } }>).filter((r) => r.properties?.active !== false);
  if (!active.length) {
    say("azure: no active revision, already off");
    return;
  }
  for (const r of active) {
    const res = await fetch(`${appUrl()}/revisions/${r.name}/deactivate?api-version=2024-03-01`, { method: "POST" });
    if (!res.ok) throw new Refusal(`azure: deactivating revision ${r.name} answered ${res.status}: ${await res.text()}`);
    say(`azure: revision ${r.name} deactivated`);
  }
}

// ---------------------------------------------------------------------------
// Wait for Route 53 to notice

/** A `chant-health/v1` document, as far as this script reads it. */
interface HealthDoc {
  lexicons?: Record<string, { entities?: Record<string, { state?: string; detail?: string }> }>;
}

/** azureCheck's state and detail as `chant lifecycle health` reads them. */
function azureCheckHealth(): { state?: string; detail?: string } {
  const r = spawnSync(CHANT, ["lifecycle", "health", ENV, "--json"], { cwd: join(ROOT, "dns"), env: childEnv, encoding: "utf8" });
  let doc: HealthDoc;
  try {
    doc = JSON.parse(r.stdout) as HealthDoc;
  } catch {
    return { detail: (r.stderr || r.stdout).trim().split("\n")[0] };
  }
  return doc.lexicons?.aws?.entities?.azureCheck ?? {};
}

/** Until azureCheck reads `want`: healthy once the apply has settled (the
 * checkers really reach floci-az), unhealthy once Azure is off. */
export async function waitFor(want: "healthy" | "unhealthy", timeoutMs = 180_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last: { state?: string; detail?: string } = {};
  while (Date.now() < until) {
    last = azureCheckHealth();
    if (last.state === want) {
      say(`dns: azureCheck reads ${want} (${last.detail})${want === "unhealthy" ? "; the azure record is out of rotation" : ""}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Refusal(`dns: azureCheck still reads ${last.state ?? "nothing"}, not ${want}, after ${timeoutMs / 1000}s${last.detail ? ` (${last.detail})` : ""}`);
}

// ---------------------------------------------------------------------------
// Export

export const NOTE =
  "Azure was switched off: its app answers 503, Route 53's check on it fails, and AWS and GCP take the traffic. Run this yourself: `npx @intentius/behold demo three-cloud`";

export function exportPage(out: string): void {
  // BEHOLD names the behold to run (a checkout's `tsx src/cli.ts`, say);
  // by default it is the published one.
  const behold = (process.env.BEHOLD ?? "npx --yes @intentius/behold").split(" ");
  // The copy the components ran in, when there is one: its remote holds their release records.
  const served = existsSync(join(RUN, "chant.workspace.json")) ? RUN : ROOT;
  const args = [...behold.slice(1), "export", served, "--out", resolve(out), "--open-env", ENV, "--open-zoom", "components", "--note", NOTE];
  say(`export: ${behold[0]} ${args.join(" ")}`);
  const r = spawnSync(behold[0]!, args, { env: childEnv, stdio: "inherit" });
  if (r.status !== 0) throw new Refusal(`behold export exited ${r.status}`);
}

// ---------------------------------------------------------------------------
// Small helpers

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Refusal(`GET ${url} answered ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function awsQuery(service: string, form: Record<string, string>): Promise<string> {
  const res = await fetch(`${AWS}/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/${service}/aws4_request, SignedHeaders=host, Signature=0`,
    },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Refusal(`${service} ${form.Action} answered ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

/** One CloudFormation stack resource's physical id (the dns stack's zone, for oob-edit). */
async function stackResourceId(stack: string, logical: string): Promise<string> {
  const xml = await awsQuery("cloudformation", { Action: "DescribeStackResource", Version: "2010-05-15", StackName: stack, LogicalResourceId: logical });
  const id = /<PhysicalResourceId>([^<]+)<\/PhysicalResourceId>/.exec(xml)?.[1];
  if (!id) throw new Refusal(`cloudformation: stack ${stack} has no resource ${logical}`);
  return id;
}

// ---------------------------------------------------------------------------
// An out-of-band edit, one per engine

/** The members oob-edit knows an edit for, and what it changes. */
export const OOB_EDITS = {
  dns: "the hosted zone's comment, through Route 53 (chant's live read compares HostedZoneConfig)",
  gcp: "a label on the Cloud Run service three-cloud-site (chant's live read compares labels)",
  azure: "a tag on the Container App web, beside its ownership markers (choudoufu's plan reads tags)",
  aws: "the retention of the log group /ecs/three-cloud-aws-web, 7 days to 14 (plunge drift refreshes it)",
} as const;

/**
 * One edit to a member's live resources that its source does not make, made
 * straight against the emulator, the way a person in a console would: no
 * chant, choudoufu or plunge runs it, so each engine has to notice it on its
 * own read, and behold's card for that resource goes from in sync to
 * drifted. For the maintainer's live run (behold#1000); nothing else calls it.
 */
export async function oobEdit(member: string): Promise<void> {
  if (member === "dns") {
    const zone = (await stackResourceId(ENV, "zone")).replace(/^\/?hostedzone\//, "");
    const body = `<?xml version="1.0" encoding="UTF-8"?><UpdateHostedZoneCommentRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><Comment>edited out of band (behold#1000)</Comment></UpdateHostedZoneCommentRequest>`;
    const res = await fetch(`${AWS}/2013-04-01/hostedzone/${zone}`, { method: "POST", headers: { "content-type": "application/xml", authorization: "AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/route53/aws4_request, SignedHeaders=host, Signature=0" }, body });
    if (!res.ok) throw new Refusal(`dns: UpdateHostedZoneComment on ${zone} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  } else if (member === "gcp") {
    const location = /kind:\s*RunService[\s\S]*?^\s+location:\s*['"]?([a-z0-9-]+)/m.exec(readFileSync(build("gcp"), "utf8"))?.[1] ?? "us-central1";
    const url = `${GCP}/v2/projects/${GCP_PROJECT}/locations/${location}/services/three-cloud-site`;
    const svc = (await getJson(url)) as { labels?: Record<string, string> };
    const res = await fetch(`${url}?updateMask=labels`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ labels: { ...(svc.labels ?? {}), "edited-out-of-band": "behold-1000" } }) });
    if (!res.ok) throw new Refusal(`gcp: patching three-cloud-site's labels answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  } else if (member === "azure") {
    const app = (await getJson(`${appUrl()}?api-version=2024-03-01`)) as { tags?: Record<string, string> };
    const res = await fetch(`${appUrl()}?api-version=2024-03-01`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ tags: { ...(app.tags ?? {}), "edited-out-of-band": "behold-1000" } }) });
    if (!res.ok) throw new Refusal(`azure: patching the container app web's tags answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  } else if (member === "aws") {
    const res = await fetch(`${AWS}/`, {
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "Logs_20140328.PutRetentionPolicy", authorization: "AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/logs/aws4_request, SignedHeaders=host, Signature=0" },
      body: JSON.stringify({ logGroupName: "/ecs/three-cloud-aws-web", retentionInDays: 14 }),
    });
    if (!res.ok) throw new Refusal(`aws: PutRetentionPolicy on /ecs/three-cloud-aws-web answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  } else {
    throw new Refusal(`oob-edit: no edit for ${member}; one of ${Object.keys(OOB_EDITS).join(", ")}`);
  }
  say(`${member}: edited out of band: ${OOB_EDITS[member as keyof typeof OOB_EDITS]}`);
}

// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const [step, ...rest] = argv;
  const outAt = rest.indexOf("--out");
  const out = outAt >= 0 ? rest[outAt + 1] : undefined;
  if (step === "plan") {
    if (!out) throw new Refusal("plan needs --out <file>");
    return void (await plan(out));
  }
  if (step === "apply") {
    const setAt = rest.indexOf("--change-set");
    if (setAt < 0) return apply();
    const file = rest[setAt + 1];
    if (!file) throw new Refusal("apply --change-set needs <file>, a document `plan --out` wrote");
    return applyApproved(file);
  }
  // One member at a time, outside chant: apply-azure is the estate's choudoufu apply, apply-aws the
  // program's plunge up, apply-dns applies dns with all three endpoints read here; gcp applies as before
  // components ran it. build-dns is the dns records component's Build step.
  if (step === "build-dns") return buildDns();
  if (step === "pr-plan-dns") {
    const baseAt = rest.indexOf("--base");
    const base = baseAt >= 0 ? rest[baseAt + 1] : undefined;
    if (!base || !out) throw new Refusal("pr-plan-dns needs --base <ref> and --out <dir>");
    return prPlanDns(base, out);
  }
  if (step === "apply-gcp") return void say(`gcp: the load balancer answers on ${await applyGcp()}`);
  if (step === "apply-azure") return void say(`azure: web answers as ${await applyAzure()}`);
  if (step === "apply-aws") return void say(`aws: web answers as ${await applyAws()}`);
  if (step === "apply-dns") return applyFrontDoorFromLive();
  if (step === "oob-edit") {
    if (!rest[0]) throw new Refusal(`oob-edit needs a member: ${Object.keys(OOB_EDITS).join(", ")}`);
    return oobEdit(rest[0]);
  }
  if (step === "azure-off") return azureOff();
  if (step === "wait") return waitFor("unhealthy");
  if (step === "export" || step === "all") {
    if (!out) throw new Refusal(`${step} needs --out <dir>`);
    if (step === "all") {
      await apply();
      await azureOff();
      await waitFor("unhealthy");
    }
    return exportPage(out);
  }
  throw new Refusal("usage: front-door.ts all|plan|apply [--change-set <file>]|apply-gcp|apply-azure|apply-aws|apply-dns|build-dns|pr-plan-dns|oob-edit <member>|azure-off|wait|export [--out <dir>|<file>] [--base <ref>]");
}

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`front-door: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(e instanceof PlanMoved ? PLAN_MOVED_EXIT_CODE : e instanceof Refusal ? 2 : 1);
});
