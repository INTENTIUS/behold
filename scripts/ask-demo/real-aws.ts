/**
 * behold#1202: read a real AWS account's security group rules once, for the
 * ask demo's question about SSH open to the internet.
 *
 *   just ask-demo-read-real-aws --account <account-id>
 *   (npx tsx scripts/ask-demo/real-aws.ts --account <account-id>)
 *
 * floci's Cloud Control lists no AWS::EC2::SecurityGroupIngress, so this one
 * read is of a real account, with the default profile's credentials. It is
 * not run under e2e/lib/safe-env.sh, which clears those, and a person runs
 * it. chant's lister reads the default profile through
 * `@aws-sdk/credential-providers`, which behold does not depend on: install
 * it beside behold first with `npm i --no-save @aws-sdk/credential-providers@3`. `--account` must name the account the default profile signs in to.
 *
 * It touches one region, us-west-2 (ASK_DEMO_REAL_AWS in ./scratch.ts), and
 * refuses before making anything unless every security group there is a
 * default VPC group named `default` and the region has a default VPC. Then:
 *
 *  1. it makes two security groups in the default VPC, `behold-ask-demo-ssh`
 *     opening tcp 22 to 0.0.0.0/0 and `behold-ask-demo-web` opening tcp 443
 *     to 0.0.0.0/0, the way someone might by hand;
 *  2. runs `behold index aws` of the region, naming exactly the security
 *     group, ingress rule and VPC types, from a temporary directory and into
 *     a temporary BEHOLD_INDEX_DIR, so nothing lands in a git repository or
 *     the user's index store;
 *  3. checks that Cloud Control returned a rule opening each port to
 *     0.0.0.0/0 as its own resource;
 *  4. deletes both groups, whatever happened before, and checks that the
 *     region again holds only its default groups;
 *  5. writes the index version to ask-demo/real-aws/index-version.json with
 *     the account id replaced by 123456789012 (./redact.ts).
 *
 * `just ask-demo-record` then loads that file as one more index source. No
 * instance, no other resource, and no other region is touched.
 */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isIndexDocument, type IndexDocument } from "../../src/graph-db/types.ts";
import { assertScratch } from "../../src/scratch.ts";
import { redactIndexVersion, REDACTED_ACCOUNT } from "./redact.ts";
import { ASK_DEMO_REAL_AWS } from "./scratch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const CLI = join(ROOT, "src", "cli.ts");

export const REAL_AWS_COMMAND = "just ask-demo-read-real-aws";
/** The redacted index version the recorder loads, relative to the repository. */
export const REAL_AWS_FILE = join("ask-demo", "real-aws", "index-version.json");

const { region: REGION, groups: GROUPS, types: TYPES } = ASK_DEMO_REAL_AWS;

const say = (s: string) => process.stdout.write(`ask-demo real-aws: ${s}\n`);

class Refusal extends Error {}

/** The default profile and nothing else: no keys from the environment, no endpoint override. */
function awsEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AWS_PROFILE: "default", AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION };
  for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "AWS_DEFAULT_PROFILE", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_EC2", "AWS_ENDPOINT_URL_CLOUDCONTROL"]) delete env[k];
  return env;
}

function run(cmd: string, args: string[], o: SpawnSyncOptions = {}): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...o });
  if (r.error) throw new Refusal(`${cmd} did not start: ${r.error.message}`);
  if (r.status !== 0) throw new Refusal(`${cmd} ${args.slice(0, 3).join(" ")} exited ${r.status}: ${String(r.stderr ?? "").trim().split("\n").slice(-4).join("\n")}`);
  return String(r.stdout ?? "");
}

const aws = (...args: string[]) => JSON.parse(run("aws", ["--region", REGION, "--output", "json", ...args], { env: awsEnv() }) || "{}") as Record<string, unknown>;

interface Group {
  GroupId: string;
  GroupName: string;
  VpcId?: string;
}

const groupsInRegion = () => (aws("ec2", "describe-security-groups") as { SecurityGroups: Group[] }).SecurityGroups;

/** Why the region is not as this script expects, or undefined: only groups named `default`. */
export function regionProblem(groups: readonly Group[]): string | undefined {
  const others = groups.filter((g) => g.GroupName !== "default");
  if (others.length) return `${REGION} holds security groups other than its default ones (${others.map((g) => `${g.GroupName} ${g.GroupId}`).join(", ")}); this script makes and deletes its own there and refuses to run beside anything else`;
  return undefined;
}

/** An ingress rule's properties as Cloud Control listed them. */
type Props = Record<string, unknown>;

/**
 * How many listed rules open tcp `port` to 0.0.0.0/0. chant's listed graph
 * keeps a rule's CidrIp, IpProtocol and ports but not its GroupId
 * (INTENTIUS/chant#5322), so the check is on those, not on the group.
 */
export function openRules(rules: readonly Props[], port: number): number {
  return rules.filter((p) => p.CidrIp === "0.0.0.0/0" && String(p.IpProtocol) === "tcp" && Number(p.FromPort) <= port && Number(p.ToPort) >= port).length;
}

function versionsUnder(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...versionsUnder(p));
    else if (/^\d{8}T\d{6}Z-[0-9a-f]{12}\.json$/.test(n)) out.push(p);
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  const at = argv.indexOf("--account");
  const account = at >= 0 ? argv[at + 1] : undefined;
  if (!account || !/^\d{12}$/.test(account)) throw new Refusal(`name the account the default profile signs in to: ${REAL_AWS_COMMAND} --account <account-id>`);
  if (process.env.BEHOLD_SAFE_ENV_DIR) throw new Refusal("this reads a real account with the default profile; e2e/lib/safe-env.sh clears those credentials, so run it outside safe-env");
  for (const g of GROUPS) assertScratch(g.name);

  const who = aws("sts", "get-caller-identity") as { Account?: string };
  if (who.Account !== account) throw new Refusal(`the default profile signs in to a different account than --account names`);
  say(`the default profile signs in to the account --account names; region ${REGION} only`);

  const before = groupsInRegion();
  const problem = regionProblem(before);
  if (problem) throw new Refusal(problem);
  const vpcs = (aws("ec2", "describe-vpcs", "--filters", "Name=is-default,Values=true") as { Vpcs: Array<{ VpcId: string }> }).Vpcs;
  if (vpcs.length !== 1) throw new Refusal(`${REGION} has ${vpcs.length} default VPCs; this script needs exactly one`);
  const vpc = vpcs[0]!.VpcId;
  say(`${REGION} holds only its default security groups (${before.length}); default VPC ${vpc}`);

  const made: Array<{ name: string; port: number; id: string }> = [];
  let tornDown = false;
  const teardown = (): string[] => {
    if (tornDown) return [];
    tornDown = true;
    const left: string[] = [];
    for (const g of made) {
      let gone = false;
      for (let i = 0; i < 6 && !gone; i++) {
        const r = spawnSync("aws", ["--region", REGION, "ec2", "delete-security-group", "--group-id", g.id], { env: awsEnv(), encoding: "utf8" });
        gone = r.status === 0 || /InvalidGroup\.NotFound/.test(r.stderr ?? "");
        if (!gone) spawnSync("sleep", ["5"]);
      }
      say(`${gone ? "deleted" : "COULD NOT DELETE"} ${g.name} ${g.id}`);
      if (!gone) left.push(`${g.name} ${g.id}`);
    }
    return left;
  };
  const onSignal = () => {
    const left = teardown();
    if (left.length) process.stderr.write(`ask-demo real-aws: still in ${REGION}, delete by hand: ${left.join(", ")}\n`);
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let indexed: IndexDocument;
  let rules: Props[];
  try {
    for (const g of GROUPS) {
      const id = (aws("ec2", "create-security-group", "--group-name", g.name, "--description", `behold ask demo: tcp ${g.port} open to the internet, deleted when the read ends`, "--vpc-id", vpc) as { GroupId: string }).GroupId;
      made.push({ name: g.name, port: g.port, id });
      aws("ec2", "authorize-security-group-ingress", "--group-id", id, "--protocol", "tcp", "--port", String(g.port), "--cidr", "0.0.0.0/0");
      say(`made ${g.name} ${id}: tcp ${g.port} from 0.0.0.0/0`);
    }

    const work = mkdtempSync(join(tmpdir(), "behold-ask-demo-real-aws-"));
    const indexDir = join(work, "index");
    say(`behold index aws --regions ${REGION} --types ${TYPES.join(",")}, from ${work}`);
    const r = spawnSync(TSX, [CLI, "index", "aws", "--account", account, "--regions", REGION, "--types", TYPES.join(",")], {
      cwd: work,
      env: { ...awsEnv(), BEHOLD_INDEX_DIR: indexDir },
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (r.status !== 0) throw new Refusal(`behold index aws exited ${r.status}`);
    const versions = versionsUnder(indexDir);
    if (versions.length !== 1) throw new Refusal(`behold index aws wrote ${versions.length} index versions under ${indexDir}; expected one`);
    const doc: unknown = JSON.parse(readFileSync(versions[0]!, "utf8"));
    if (!isIndexDocument(doc)) throw new Refusal(`${versions[0]} is not an index version`);
    indexed = doc;
    rules = doc.graph.nodes.filter((n) => n.kind === "AWS::EC2::SecurityGroupIngress").map((n) => (n.attrs ?? {}) as Props);
    for (const c of (doc as { coverage?: Array<{ listedType: string; verdict: string; detail?: string }> }).coverage ?? []) say(`coverage ${c.listedType}: ${c.verdict}${c.detail ? ` (${c.detail})` : ""}`);
    for (const g of made) {
      if (openRules(rules, g.port) < 1) {
        const first = doc.graph.nodes.find((n) => n.kind === "AWS::EC2::SecurityGroupIngress");
        throw new Refusal(`Cloud Control returned no AWS::EC2::SecurityGroupIngress opening tcp ${g.port} to 0.0.0.0/0 (made for ${g.name}); it listed ${rules.length} rules${first ? `, the first with attrs ${JSON.stringify(first.attrs ?? {})}` : ""}`);
      }
    }
  } finally {
    const left = teardown();
    const after = groupsInRegion();
    const still = after.filter((g) => made.some((m) => m.id === g.GroupId));
    if (left.length || still.length || regionProblem(after)) {
      process.stderr.write(`ask-demo real-aws: ${REGION} still holds ${[...left, ...still.map((g) => `${g.GroupName} ${g.GroupId}`)].join(", ") || "groups other than its default ones"}; delete them by hand\n`);
      process.exitCode = 1;
    } else {
      say(`checked: ${REGION} holds only its default security groups again (${after.length})`);
    }
  }
  if (process.exitCode) return 1;

  const { doc: redacted, version } = redactIndexVersion(indexed, account);
  const out = join(ROOT, REAL_AWS_FILE);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(redacted, null, 2)}\n`);
  for (const n of redacted.graph.nodes.filter((x) => x.kind === "AWS::EC2::SecurityGroupIngress")) process.stdout.write(`  rule ${n.id}\n    ${JSON.stringify(n.attrs)}\n`);
  say(`wrote ${relative(process.cwd(), out) || out} (version ${version}, scope ${redacted.stamp.scopeKey}), the account id replaced by ${REDACTED_ACCOUNT}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`ask-demo real-aws: ${e instanceof Refusal ? e.message : (e as Error).stack ?? String(e)}\n`);
      process.exit(1);
    },
  );
}
