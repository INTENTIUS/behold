/**
 * behold#1245: doctor's line for a cloudformation member that names deployed
 * stacks (`cloudformation-stacks.json`, chant#5455).
 *
 * chant's aws lexicon reads each named stack with three CloudFormation calls
 * (DescribeStacks, DescribeStackResources, GetTemplate), so a read needs three
 * things on this machine: a chant that has the read, a region, and AWS
 * credentials. behold checks the three before a graph route is asked, and says
 * the missing one with the step that fixes it. It reads the member's
 * declaration only; chant's own answer on `meta.awsMember.stacks` is what a
 * stack's card says, and an unread stack there carries chant's reason.
 *
 * Credentials are looked for where the AWS SDKs look first: an access key
 * pair or session token, a named profile, a web identity token, a container
 * or instance role endpoint, or the shared credentials file. A machine that
 * gets them some other way gets a warn it can ignore, and the stack's card
 * says what chant found.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import type { DoctorCheck } from "./doctor.ts";

/** The read this check is about, by its name in src/chant-floors.ts. */
export const STACK_READ = "deployed CloudFormation stacks";
/** The file chant reads the stack names from. */
export const STACKS_FILE = "cloudformation-stacks.json";

export interface StackDeclaration {
  stacks: string[];
  region?: string;
}

/** What `cloudformation-stacks.json` in `dir` declares, undefined when there is none, or `{ error }` when it is not the shape chant reads. */
export function readStackDeclaration(dir: string): StackDeclaration | { error: string } | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dir, STACKS_FILE), "utf8");
  } catch {
    return undefined;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { error: `${STACKS_FILE} is not JSON: ${(e as Error).message}` };
  }
  const o = doc as { stacks?: unknown; region?: unknown } | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.stacks) || o.stacks.length === 0 || !o.stacks.every((n) => typeof n === "string" && n !== "")) {
    return { error: `${STACKS_FILE} must be { "stacks": ["<stack name>", ...], "region": "<region>" } with at least one stack name` };
  }
  return { stacks: o.stacks as string[], ...(typeof o.region === "string" && o.region ? { region: o.region } : {}) };
}

/** Does the environment (or the shared credentials file) hold something an AWS SDK would sign with? */
export function hasAwsCredentials(env: NodeJS.ProcessEnv, home: string = homedir()): boolean {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return true;
  if (env.AWS_PROFILE || env.AWS_WEB_IDENTITY_TOKEN_FILE || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI) return true;
  return existsSync(join(home, ".aws", "credentials"));
}

export interface StackCheckOpts {
  root: string;
  /** The workspace's chant version, which answers the read. */
  chantVersion: string | undefined;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** One check per cloudformation member that declares stacks, each naming what is missing for chant to read them. */
export function stackChecks(members: readonly { name: string; dir: string; abs: string }[], opts: StackCheckOpts): DoctorCheck[] {
  const env = opts.env ?? process.env;
  const out: DoctorCheck[] = [];
  for (const m of members) {
    const decl = readStackDeclaration(m.abs);
    if (!decl) continue;
    const where = relative(opts.root, m.abs) || ".";
    if ("error" in decl) {
      out.push({ name: "stacks", status: "fail", detail: `${m.name} (${where}): ${decl.error}`, fix: `Write ${STACKS_FILE} as { "stacks": ["<stack name>"], "region": "<region>" }.` });
      continue;
    }
    const head = `${m.name} (${where}) names ${decl.stacks.length} deployed stack${decl.stacks.length === 1 ? "" : "s"}: ${decl.stacks.join(", ")}`;
    const f = floorFor(STACK_READ);
    if (!floorMet(f, opts.chantVersion)) {
      out.push({ name: "stacks", status: "warn", detail: `${head}; ${floorRefusal(f, opts.chantVersion).error}`, fix: `Upgrade @intentius/chant and the aws lexicon to ${f.floor} or newer; until then the member draws its template files only.` });
      continue;
    }
    const problems: string[] = [];
    const fixes: string[] = [];
    const region = decl.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    if (!region) {
      problems.push("no region");
      fixes.push(`name one in ${STACKS_FILE} ("region") or set AWS_REGION`);
    }
    if (!hasAwsCredentials(env, opts.home)) {
      problems.push("no AWS credentials found");
      fixes.push("set AWS_PROFILE, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, for an identity that allows cloudformation:DescribeStacks, cloudformation:DescribeStackResources and cloudformation:GetTemplate");
    }
    out.push(
      problems.length
        ? { name: "stacks", status: "warn", detail: `${head}; ${problems.join(", ")}`, fix: `${fixes.join("; ")}. Until then chant draws each stack as unread, with its reason.` }
        : { name: "stacks", status: "pass", detail: `${head}; region ${region}, credentials present` },
    );
  }
  return out;
}
