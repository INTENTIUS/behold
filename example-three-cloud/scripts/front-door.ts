/**
 * The front door, rebuilt on the floci emulators: apply the four members,
 * turn Azure off, wait for Route 53 to notice, and export the page.
 *
 *   tsx scripts/front-door.ts all --out <dir>     every step below, in order
 *   tsx scripts/front-door.ts apply               build and apply gcp, azure, aws, then dns, and wait
 *                                                 until `chant lifecycle health` reads azureCheck healthy
 *   tsx scripts/front-door.ts azure-off           deactivate the Azure app's active revision
 *   tsx scripts/front-door.ts wait                until azureCheck reads unhealthy
 *   tsx scripts/front-door.ts export --out <dir>  behold export, opening on env local at the logical zoom
 *
 * dns/ops/front-door.op.ts runs the same steps as an Op's phases. The emulators
 * are the ones `behold demo three-cloud` boots (chant-floci, chant-floci-az,
 * chant-floci-gcp); FLOCI_CONTAINER, FLOCI_AZ_CONTAINER and FLOCI_GCP_CONTAINER
 * name others, and AWS_ENDPOINT_URL, AZURE_ENDPOINT_URL and GCP_ENDPOINT_URL
 * say where they answer.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { awsApply, awsDelete } from "@intentius/chant-lexicon-aws/op/activities";
import { azApply } from "@intentius/chant-lexicon-azure/op/activities";
import { gcpApply } from "@intentius/chant-lexicon-gcp/op/activities";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORK = join(ROOT, ".front-door");
const CHANT = join(ROOT, "node_modules", ".bin", "chant");

const ENV = "local";
// The Azure resource group and the GCP project, as chant's live reads find them:
// the resource group is named after the environment.
const RESOURCE_GROUP = ENV;
const GCP_PROJECT = process.env.GCP_PROJECT_ID ?? "three-cloud";
const GCP_REGION = process.env.GCP_REGION ?? "asia-northeast1";
const SUBSCRIPTION = process.env.AZURE_SUBSCRIPTION_ID ?? "00000000-0000-0000-0000-000000000001";

const AWS = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const AZURE = process.env.AZURE_ENDPOINT_URL ?? "http://localhost:4577";
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

async function applyAzure(): Promise<string> {
  const template = build("azure");
  say(`azure: applying ${template} to ${AZURE} (resource group ${RESOURCE_GROUP})`);
  await azApply({ templatePath: template, resourceGroup: RESOURCE_GROUP, location: "westeurope", endpoint: AZURE, subscriptionId: SUBSCRIPTION });
  const app = await getJson(`${appUrl()}?api-version=2024-03-01`);
  const fqdn = (app.properties as { configuration?: { ingress?: { fqdn?: string } } } | undefined)?.configuration?.ingress?.fqdn;
  if (!fqdn) throw new Refusal(`azure: the container app web has no ingress fqdn (${JSON.stringify(app).slice(0, 300)})`);
  await azureOn();
  return fqdn;
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
  const gcp = await applyGcp();
  say(`gcp: the load balancer answers on ${gcp}`);
  const azure = await applyAzure();
  say(`azure: web answers as ${azure}`);
  const aws = await applyAws();
  await applyFrontDoor(gcp, azure, aws);
  // Before anything is turned off, the check on Azure has to pass: that is
  // what shows the checkers reach floci-az at all.
  await waitFor("healthy");
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
  const args = [...behold.slice(1), "export", ROOT, "--out", resolve(out), "--open-env", ENV, "--open-zoom", "logical", "--note", NOTE];
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
  if (step === "apply") return apply();
  // One member at a time: the steps of each member's component (<member>/src/*.component.ts).
  if (step === "apply-gcp") return void say(`gcp: the load balancer answers on ${await applyGcp()}`);
  if (step === "apply-azure") return void say(`azure: web answers as ${await applyAzure()}`);
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
  throw new Refusal("usage: front-door.ts all|apply|apply-gcp|apply-azure|apply-dns|azure-off|wait|export [--out <dir>]");
}

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`front-door: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(e instanceof Refusal ? 2 : 1);
});
