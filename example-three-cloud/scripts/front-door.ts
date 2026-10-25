/**
 * The front door, rebuilt on the floci emulators: apply the four members,
 * turn Azure off, wait for Route 53 to notice, and export the page.
 *
 *   tsx scripts/front-door.ts all --out <dir>     apply, azure-off, wait and export, in order
 *   tsx scripts/front-door.ts plan --out <file>   one change set over the four members: `chant lifecycle
 *                                                 plan` for dns, aws and gcp, chant's choudoufuPlanSet
 *                                                 for the azure estate, composed under one digest
 *   tsx scripts/front-door.ts apply               run each chant member's component (gcp, aws, then dns)
 *                                                 with `chant run --components`, in a copy of the
 *                                                 workspace, apply the azure estate after gcp, and wait
 *                                                 until `chant lifecycle health` reads azureCheck healthy
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
 * names it as the lexicon's `azure` root: choudoufuPlanSet runs `choudoufu
 * live-plan-set` over it, and choudoufuWaveApply applies exactly that set.
 * Its record store and provider schemas stay in azure/, and the copy links
 * to them. choudoufu is the one on PATH, or CHOUDOUFU_BIN. Every choudoufu
 * call runs under the floci-az endpoint lock choudoufu's own Azure estates
 * use (lockAzureEnv), so nothing it starts can reach a real subscription.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeChangeSet, lifecyclePlanPart, type ChangeSetDocument, type ChangeSetPart } from "@intentius/chant/change-set";
import type { ChangeSet as LifecycleChangeSet } from "@intentius/chant/lifecycle/change-set";
import { awsApply, awsDelete } from "@intentius/chant-lexicon-aws/op/activities";
import { gcpApply } from "@intentius/chant-lexicon-gcp/op/activities";
import { choudoufuPlanSet, choudoufuWaveApply, terraformOutputs } from "@intentius/chant-lexicon-terraform/op/activities/terraform";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

// ---------------------------------------------------------------------------
// Build

function build(member: string): string {
  const out = join(WORK, member === "gcp" ? "gcp.yaml" : `${member}.json`);
  mkdirSync(WORK, { recursive: true });
  const r = spawnSync(CHANT, ["build", "src", "-o", out], { cwd: join(ROOT, member), env: childEnv, encoding: "utf8" });
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
    ARM_CLIENT_SECRET: "floci-az-does-not-check-this",
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
// Plan: one change set over the four members

/** `chant lifecycle plan <env> --json` in a chant member, parsed. */
function lifecyclePlan(member: string): LifecycleChangeSet {
  const r = spawnSync(CHANT, ["lifecycle", "plan", ENV, "--json"], { cwd: join(ROOT, member), env: childEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Refusal(`${member}: chant lifecycle plan ${ENV} failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout) as LifecycleChangeSet;
}

/**
 * The change set a run over the whole workspace would approve: a chant part
 * for each of dns, aws and gcp, and the azure estate's choudoufu part from
 * choudoufuPlanSet (choudoufu's root digest as its nativeDigest), composed
 * under one document digest. Written to `out`. Reads only: nothing applies.
 */
export async function plan(out: string): Promise<ChangeSetDocument> {
  const parts: ChangeSetPart[] = [];
  for (const member of ["dns", "aws", "gcp"]) {
    say(`${member}: chant lifecycle plan ${ENV}`);
    parts.push(lifecyclePlanPart({ member, plan: lifecyclePlan(member) }));
  }
  await lockAzureEnv();
  say(`azure: choudoufu live-plan-set over the azure estate, on floci-az at ${AZURE_HOST}`);
  parts.push((await choudoufuPlanSet(AZURE_ROOT)).changeSet);
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
  const set = await choudoufuPlanSet(AZURE_ROOT);
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

/** The aws member, or why it could not be applied. */
async function applyAws(): Promise<{ endpoint: string } | { refused: string }> {
  const params = build("aws");
  // A stack that rolled back on its first create can't be updated; start it again.
  if ((await stackStatus("three-cloud-aws")) === "ROLLBACK_COMPLETE") {
    await awsDelete({ templatePath: params, stackName: "three-cloud-aws", endpoint: AWS, timeoutMs: 180_000 });
  }
  say(`aws: applying ${params} to ${AWS} as stack three-cloud-aws`);
  try {
    await awsApply({ templatePath: params, stackName: "three-cloud-aws", endpoint: AWS, timeoutMs: 180_000 });
  } catch (e) {
    const why = await stackFailure("three-cloud-aws");
    return { refused: `${e instanceof Error ? e.message : String(e)}${why ? `: ${why}` : ""}` };
  }
  const out = await stackOutputs("three-cloud-aws");
  return out.awsEndpoint ? { endpoint: out.awsEndpoint } : { refused: "the stack has no awsEndpoint output" };
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

async function applyDns(endpoints: Record<string, string>, probes: Record<string, Probe>): Promise<void> {
  const params = withDefaults(build("dns"), endpoints);
  withProbes(params, probes);
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
  runComponent("aws", "site");
  runComponent("dns", "records");
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
    if (!skip.test(e) && e !== ".chant") cpSync(join(ROOT, e), join(RUN, e), { recursive: true, filter: (src) => !skip.test(relative(ROOT, src)) && !AZURE_STATE.includes(relative(ROOT, src)) });
  }
  symlinkSync(join(ROOT, "node_modules"), join(RUN, "node_modules"));
  // The azure estate's schemas, lock file and records, linked rather than
  // copied: behold reads the estate in the copy, and choudoufu applies it here.
  for (const p of AZURE_STATE) symlinkSync(join(ROOT, p), join(RUN, p));
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

/** One member's component, through chant's own deploy steps, against the emulators. */
function runComponent(member: string, component: string): void {
  say(`${member}: chant run --components ${component} --env ${ENV}`);
  const r = spawnSync(join(RUN, "node_modules", ".bin", "chant"), ["run", "--components", component, "--env", ENV], {
    cwd: join(RUN, member),
    env: { ...childEnv, USER: "three-cloud-demo", GIT_AUTHOR_NAME: "three-cloud demo", GIT_AUTHOR_EMAIL: "demo@three-cloud.test", GIT_COMMITTER_NAME: "three-cloud demo", GIT_COMMITTER_EMAIL: "demo@three-cloud.test" },
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Refusal(`${member}: the ${component} component did not apply (exit ${r.status})`);
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

/** The dns member alone, reading the three endpoints from what is already applied (its component's step). */
async function applyFrontDoorFromLive(): Promise<void> {
  const out = await stackOutputs("three-cloud-aws");
  const app = await getJson(`${appUrl()}?api-version=2024-03-01`);
  const azure = (app.properties as { configuration?: { ingress?: { fqdn?: string } } } | undefined)?.configuration?.ingress?.fqdn;
  if (!azure) throw new Refusal("azure: the container app web has no ingress fqdn; apply the azure member first");
  const addr = (await fetch(`${GCP}/compute/v1/projects/${GCP_PROJECT}/global/addresses/three-cloud-ip`).then((r) => (r.ok ? r.json() : {}))) as { address?: string };
  await applyFrontDoor(addr.address ?? "192.0.2.1", azure, out.awsEndpoint ? { endpoint: out.awsEndpoint } : { refused: "the stack has no awsEndpoint output" });
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

async function stackStatus(stack: string): Promise<string | undefined> {
  try {
    const xml = await awsQuery("cloudformation", { Action: "DescribeStacks", Version: "2010-05-15", StackName: stack });
    return /<StackStatus>([^<]+)<\/StackStatus>/.exec(xml)?.[1];
  } catch {
    return undefined;
  }
}

/** The first resource-level reason a stack's events give for failing. */
async function stackFailure(stack: string): Promise<string | undefined> {
  try {
    const xml = await awsQuery("cloudformation", { Action: "DescribeStackEvents", Version: "2010-05-15", StackName: stack });
    for (const event of xml.split("<member>")) {
      const field = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(event)?.[1];
      const id = field("LogicalResourceId");
      const reason = field("ResourceStatusReason");
      if (id && id !== stack && field("ResourceStatus") === "CREATE_FAILED" && reason) {
        return `${id}: ${reason.replace(/&apos;/g, "'").replace(/&quot;/g, '"')}`;
      }
    }
  } catch {
    // no events to read; the applier's own message stands
  }
  return undefined;
}

async function stackOutputs(stack: string): Promise<Record<string, string>> {
  const xml = await awsQuery("cloudformation", { Action: "DescribeStacks", Version: "2010-05-15", StackName: stack });
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<OutputKey>([^<]+)<\/OutputKey>\s*<OutputValue>([^<]*)<\/OutputValue>/g)) out[m[1]!] = m[2]!;
  return out;
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
  if (step === "apply") return apply();
  // One member at a time, outside chant: apply-dns is the dns component's step, apply-azure the estate's
  // choudoufu apply; the others apply as before components ran them.
  if (step === "apply-gcp") return void say(`gcp: the load balancer answers on ${await applyGcp()}`);
  if (step === "apply-azure") return void say(`azure: web answers as ${await applyAzure()}`);
  if (step === "apply-aws") {
    const aws = await applyAws();
    return void say("refused" in aws ? `aws: NOT APPLIED: ${aws.refused}` : `aws: web answers as ${aws.endpoint}`);
  }
  if (step === "apply-dns") return applyFrontDoorFromLive();
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
  throw new Refusal("usage: front-door.ts all|plan|apply|apply-gcp|apply-azure|apply-aws|apply-dns|azure-off|wait|export [--out <dir>|<file>]");
}

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`front-door: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(e instanceof Refusal ? 2 : 1);
});
