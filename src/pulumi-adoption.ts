/**
 * behold#999, the Pulumi half: "adopt this stack". A stock Pulumi stack
 * member of a declared workspace (kind `pulumi`, chant's
 * @intentius/chant-lexicon-pulumi) is offered adoption into plunge, the
 * engine tier, through plunge's own `plunge stack adopt` (INTENTIUS/plunge#7,
 * P-L4: plunge pkg/cmd/pulumi/stack/stack_adopt.go and
 * pkg/backend/plunge/adopt.go).
 *
 * `plunge stack adopt` gates itself. It classifies every resource of the
 * stock checkpoint first and writes nothing until it is confirmed: `--yes`,
 * or a person typing the stack's name at its prompt. behold runs only that
 * read-only stage, as `plunge stack adopt --json` (INTENTIUS/plunge#17,
 * plunge docs/plunge/ADOPT.md): one v1 document on stdout with the stack, the
 * checkpoint digest, the status, every resource with its fate and reason, and
 * each refusal with its code and URN. `--json` without `--yes` never prompts
 * and writes nothing. behold reads that document only:
 *
 * - `GET /api/adopt/report` runs it and gives each resource its fate. A
 *   refusal (pending operations, a provider whose ignoreTags or defaultTags
 *   would hide the markers, an aws-native type whose tags are create-only) is
 *   plunge's own, before anything is written, and each reason is listed.
 * - `POST /api/adopt/start` runs the same classification as a delegated
 *   action through the runner's `track`, so it holds the single-writer guard
 *   and shows on the now-line, and answers the confirm command. Confirming is
 *   a person's act: behold never passes `--yes` (or `-y`), strips
 *   PULUMI_SKIP_CONFIRMATIONS from the environment it hands plunge, gives
 *   plunge no stdin and passes `--non-interactive`, so plunge's prompt can
 *   never be answered for it. {@link assertClassificationOnly} refuses any
 *   other argv before it reaches the spawner.
 *
 * Which backend. plunge adopts at the root of the DIY backend the stock stack
 * lives in, as `plunge+<that url>`, and by default reads the stock checkpoint
 * there. behold takes the URL from the member's own `Pulumi.yaml`
 * (`backend.url`), the file chant's lexicon reads to decide a member's engine
 * (lexicons/pulumi/src/run.ts `pulumiMemberEngine`), and never from the
 * machine's login state, so the offer says the same on every checkout. A
 * `file://`, `s3://`, `gs://` or `azblob://` URL is a DIY backend; a `plunge+`
 * one is already plunge's (adoption is still offered: a stack plunge has no
 * records for is refused every run until it is adopted, and an adopted one
 * answers "already adopted"). Anything else (Pulumi Cloud, no URL) is not
 * offered, with the reason.
 *
 * Which stack. The stack the checked-in `stack-export.json` was exported from
 * (its URNs are `urn:pulumi:<stack>::<project>::...`), or one the request
 * names.
 *
 * The plunge binary is the one on PATH (the name chant's lexicon runs,
 * `defaultPlungeRunner`). One without the JSON view is detected from its
 * answer (cobra's unknown flag), not from a version, and refused with words
 * naming the plunge commit that adds the view ({@link PLUNGE_ADOPT_JSON_COMMIT}).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";
import type { Adopter } from "./adoption.ts";
import { stripAnsi } from "./ansi.ts";
import type { WorkspaceMember } from "./workspace.ts";

/** What adopting a stock Pulumi stack into plunge gives it, per plunge#7 (P-L3, P-L4). */
export const PULUMI_ADOPTER: Adopter = {
  kind: "pulumi",
  engine: "plunge",
  gains: [
    "Ownership moves from one checkpoint behind one stack lock to a record per resource in plunge's store, and marker tags on each taggable resource (plunge-stack and plunge-urn).",
    "No stack lock is held across a run: two runs that change different resources of the stack both land.",
    "Adoption keeps the checkpoint's IDs. Each resource's state becomes its own record unchanged, nothing is read from or written to the cloud, and the markers land at the next plunge up as in-place tag updates.",
    "Adoption is recorded (stacks/<project>/<stack>/adoption), and adopting the same checkpoint again writes nothing. Backing out: plunge stack export, then pulumi stack import on a stock backend; pulumi preview --refresh then shows only the removal of the plunge-* tags.",
  ],
  limits: [
    "plunge refuses the whole adoption, before writing anything, when the checkpoint has pending operations, when a provider's ignoreTags or defaultTags would hide the markers, or when an aws-native resource's tags can only be set at create (marking it would replace it).",
    "Bridged provider types (aws, azure, gcp) are classed at the first plunge run, from the provider's schema, so adoption lists them as pending. A create-only-tag type is refused there, never replaced.",
    "A type with no tags plunge can write is owned by its record alone: nothing on the live object says which stack owns it.",
  ],
  state:
    "plunge reads the stock checkpoint at the root of the DIY backend the stack lives in. behold takes it from backend.url in the member's Pulumi.yaml (file://, s3://, gs:// or azblob://). A stack on Pulumi Cloud is exported and adopted by hand: plunge stack adopt --file <export>.",
};

/** The checked-in export chant's pulumi lexicon reads (lexicons/pulumi `PULUMI_EXPORT_FILE`). */
export const PULUMI_EXPORT_FILE = "stack-export.json";

/** A stack name, `org/project/stack` included. Never a flag. */
const STACK = /^[A-Za-z0-9_][A-Za-z0-9._\/-]{0,120}$/;
const DIY = /^(file|s3|gs|azblob):\/\//;
const ON_PLUNGE = /^plunge[+:]/;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** The plunge backend a member's stack is adopted at, from its Pulumi.yaml. */
export type PlungeBackend = { ok: true; url: string; declared: string; onPlunge: boolean } | { ok: false; declared: string | null; why: string };

export function plungeBackendFor(dir: string): PlungeBackend {
  const file = join(dir, "Pulumi.yaml");
  if (!existsSync(file)) return { ok: false, declared: null, why: "the member has no Pulumi.yaml" };
  let url: unknown;
  try {
    const doc = parseYAML(readFileSync(file, "utf8"));
    url = isRecord(doc.backend) ? doc.backend.url : undefined;
  } catch {
    return { ok: false, declared: null, why: "the member's Pulumi.yaml does not read as YAML" };
  }
  if (!str(url)) {
    return {
      ok: false,
      declared: null,
      why: "the member's Pulumi.yaml names no backend.url, so behold cannot tell which DIY backend the stock checkpoint is in. Add one (file://, s3://, gs:// or azblob://), or run plunge stack adopt by hand with PULUMI_BACKEND_URL=plunge+<that url>.",
    };
  }
  if (ON_PLUNGE.test(url)) return { ok: true, url, declared: url, onPlunge: true };
  if (DIY.test(url)) return { ok: true, url: `plunge+${url}`, declared: url, onPlunge: false };
  return {
    ok: false,
    declared: url,
    why: `the member's backend ${url} is not a DIY backend, and plunge adopts at a DIY backend's root. Export the stack (pulumi stack export --file s.json) and adopt it by hand into a plunge+<diy url> backend with plunge stack adopt --file s.json.`,
  };
}

/** The stack the member's checked-in export came from, read off its first URN. */
export function exportedStack(dir: string): string | undefined {
  const file = join(dir, PULUMI_EXPORT_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as { deployment?: { resources?: Array<{ urn?: unknown }> } };
    for (const r of doc.deployment?.resources ?? []) {
      const m = typeof r.urn === "string" ? /^urn:pulumi:([^:]+)::/.exec(r.urn) : null;
      if (m && STACK.test(m[1]!)) return m[1];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The stack to adopt: the request's, when it is a stack name, else the export's. */
export function stackFor(member: WorkspaceMember, ask?: string): { ok: true; stack: string; from: "request" | "export" } | { ok: false; error: string } {
  if (ask !== undefined && ask !== "") {
    if (!STACK.test(ask)) return { ok: false, error: "stack names a Pulumi stack (letters, digits, . _ - and /), never a flag" };
    return { ok: true, stack: ask, from: "request" };
  }
  const exported = member.abs ? exportedStack(member.abs) : undefined;
  if (exported) return { ok: true, stack: exported, from: "export" };
  return { ok: false, error: `behold cannot tell which stack ${member.name} is: it has no ${PULUMI_EXPORT_FILE} to read one from. Name it (stack=<name>).` };
}

/** The argv behold runs: the classification as plunge's JSON view, never confirmed. */
export function plungeClassifyArgv(stack: string): string[] {
  return ["stack", "adopt", "--stack", stack, "--json", "--non-interactive", "--color", "never"];
}

/**
 * Refuse anything but the classification. `--yes`/`-y` confirms the adoption,
 * and `--file` would adopt from a file the request chose; neither reaches the
 * spawner.
 */
export function assertClassificationOnly(args: readonly string[]): void {
  const ok = args[0] === "stack" && args[1] === "adopt" && args.includes("--non-interactive") && !args.some((a) => a === "-y" || a.startsWith("--yes") || a.startsWith("-y=") || a.startsWith("--file"));
  if (!ok) throw new Error(`behold runs plunge stack adopt only to classify, never to confirm it: not plunge ${args.join(" ")}`);
}

/** The environment plunge gets: the member's backend, and nothing that would confirm for it. */
export function plungeEnv(base: NodeJS.ProcessEnv, backendUrl: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && k !== "PULUMI_SKIP_CONFIRMATIONS") env[k] = v;
  env.PULUMI_BACKEND_URL = backendUrl;
  env.PULUMI_SKIP_UPDATE_CHECK = "true";
  env.NO_COLOR = "1";
  return env;
}

const shellWord = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The command behold runs, as a person would type it from the workspace root. */
export function classifyCommandLine(dir: string, backendUrl: string, stack: string): string {
  return `cd ${shellWord(dir)} && PULUMI_BACKEND_URL=${shellWord(backendUrl)} plunge stack adopt --stack ${shellWord(stack)}`;
}

/** The confirm command: a person's, never behold's. It writes the records and the adoption record. */
export function confirmCommandLine(dir: string, backendUrl: string, stack: string): string {
  return `cd ${shellWord(dir)} && PULUMI_BACKEND_URL=${shellWord(backendUrl)} plunge stack adopt --stack ${shellWord(stack)} --yes`;
}

/** After the confirm: point the member at plunge, so chant reads and runs it through plunge (pulumiMemberEngine). */
export function afterConfirmLine(backend: { url: string; onPlunge: boolean }): string {
  return backend.onPlunge
    ? "Pulumi.yaml already names the plunge backend, so chant runs the member through plunge."
    : `Then set backend.url in Pulumi.yaml to ${backend.url}, so chant reads and runs the member through plunge, and commit it.`;
}

/** How to back out, from P-L4. */
export function backOutLine(dir: string, backendUrl: string, stack: string): string {
  return `cd ${shellWord(dir)} && PULUMI_BACKEND_URL=${shellWord(backendUrl)} plunge stack export --stack ${shellWord(stack)} --file s.json, then pulumi stack import --stack ${shellWord(stack)} --file s.json on the stock backend`;
}

/** plunge's ownership classes, and what each means for the resource. */
export type PulumiOwnership = "marker" | "record" | "pending";
export const PULUMI_FATES: Readonly<Record<PulumiOwnership, { fate: "claimed"; why: string }>> = {
  marker: { fate: "claimed", why: "claimed by marker: its record is written, and plunge-stack and plunge-urn land on it at the next plunge up, an in-place tag update" },
  record: { fate: "claimed", why: "claimed by its record alone: plunge has nowhere on the type to write a marker" },
  pending: { fate: "claimed", why: "claimed; its record is written, and it is classed at the first plunge up from the provider's schema, where a create-only-tag type is refused and never replaced" },
};

export interface PulumiAdoptionRow {
  urn: string;
  type: string;
  name: string;
  id: string;
  ownership: string;
  fate: "claimed" | "unknown";
  /** behold's line for the ownership. */
  why: string;
  /** plunge's own reason, verbatim. */
  detail: string;
  /** The checkpoint's inputs already carry this stack's markers. */
  marked: boolean;
}

export interface PulumiRefusal {
  /** plunge's refusal code (docs/plunge/ADOPT.md); one behold does not know is still a refusal. */
  code: string;
  reason: string;
  /** The resource or provider the reason names, when it names one. */
  urn: string | null;
}

/** What `plunge stack adopt --json` said, without `--yes`. */
export interface PulumiClassification {
  /**
   * `classified`: plunge listed every resource and wrote nothing, waiting on
   * the confirm. `already-adopted`: the stack was adopted from this
   * checkpoint; nothing was written. `refused`: plunge refused before writing
   * anything. `written`: plunge says it wrote records, which behold never
   * asks for (shown as said). `no-view`: this plunge has no
   * `stack adopt --json` (built before {@link PLUNGE_ADOPT_JSON_COMMIT}).
   * `unreadable`: a document version behold does not read. `failed`:
   * anything else, plunge's words below.
   */
  outcome: "classified" | "already-adopted" | "refused" | "written" | "no-view" | "unreadable" | "failed";
  stack: string | null;
  digest: string | null;
  entries: PulumiAdoptionRow[];
  refused: PulumiRefusal[];
  /** The last lines plunge printed on stderr, or behold's words for a document it cannot read, when the outcome needs them. */
  said: string;
}

/** A URN's type and name: `urn:pulumi:<stack>::<project>::<parent$>type::<name>`. */
export function urnParts(urn: string): { type: string; name: string } {
  const parts = urn.split("::");
  if (parts.length < 4) return { type: "", name: urn };
  const qualified = parts[2]!;
  return { type: qualified.slice(qualified.lastIndexOf("$") + 1), name: parts.slice(3).join("::") };
}

/** The plunge commit that adds `plunge stack adopt --json` (INTENTIUS/plunge#17), on plunge's integration/engine-ship. */
export const PLUNGE_ADOPT_JSON_COMMIT = "968b54748d";
/** The `adopt` version of plunge's document (plunge docs/plunge/ADOPT.md) behold reads. */
export const PLUNGE_ADOPT_VIEW = "v1";

// What a plunge built before the view answers to --json (cobra's unknown flag), or before stack adopt at all.
const NO_VIEW = /unknown flag: --json|unknown shorthand flag: 'j'|unknown command "adopt"/;
// plunge's own refusal of the whole stack is a document; its other errors are plain stderr.
const STATUS: Readonly<Record<string, PulumiClassification["outcome"]>> = {
  "would-adopt": "classified",
  "already-adopted": "already-adopted",
  adopted: "written",
  refused: "refused",
};

/** The one JSON document plunge prints on stdout, or undefined. */
function adoptDocument(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const doc = JSON.parse(text) as unknown;
    return isRecord(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}

function refusalOf(v: unknown): PulumiRefusal | undefined {
  if (!isRecord(v)) return undefined;
  const code = str(v.code) ? v.code : "";
  const reason = str(v.reason) ? v.reason : `plunge refused with code ${code || "(none)"}, which behold cannot explain`;
  return { code, reason, urn: str(v.urn) ? v.urn : null };
}

function rowOf(v: unknown): PulumiAdoptionRow | undefined {
  if (!isRecord(v) || !str(v.urn)) return undefined;
  const urn = v.urn;
  const fate = str(v.fate) ? v.fate : "";
  // An already-adopted resource carries the class its adoption record holds.
  const ownership = fate === "already-adopted" && str(v.adoptedAs) ? v.adoptedAs : fate;
  const known = Object.prototype.hasOwnProperty.call(PULUMI_FATES, ownership) ? PULUMI_FATES[ownership as PulumiOwnership] : undefined;
  const parts = urnParts(urn);
  return {
    urn,
    type: str(v.type) ? v.type : parts.type,
    name: parts.name,
    id: typeof v.id === "string" ? v.id : "",
    ownership,
    fate: known ? known.fate : "unknown",
    why: known ? known.why : `plunge gave an ownership behold does not know (${ownership || "none"}); its reason is beside it`,
    detail: str(v.reason) ? v.reason : "",
    marked: v.marked === true,
  };
}

/**
 * Read `plunge stack adopt --json`: one v1 document on stdout (plunge
 * docs/plunge/ADOPT.md). stderr is read only when there is no document: a
 * plunge without the view, or an error that is not an adoption outcome. Pure.
 */
export function parsePlungeAdopt(stdout: string, stderr: string): PulumiClassification {
  const err = stripAnsi(stderr).trim();
  const tail = err.split("\n").slice(-6).join("\n");
  const none: PulumiClassification = { outcome: "failed", stack: null, digest: null, entries: [], refused: [], said: tail };
  const doc = adoptDocument(stripAnsi(stdout));
  if (!doc) return NO_VIEW.test(err) ? { ...none, outcome: "no-view" } : none;
  if (doc.adopt !== PLUNGE_ADOPT_VIEW) {
    return { ...none, outcome: "unreadable", said: `plunge answered an adopt document of version ${str(doc.adopt) ? doc.adopt : "(none)"}; behold reads ${PLUNGE_ADOPT_VIEW}` };
  }
  const status = str(doc.status) ? doc.status : "";
  const outcome = Object.prototype.hasOwnProperty.call(STATUS, status) ? STATUS[status]! : "failed";
  const checkpoint = isRecord(doc.checkpoint) ? doc.checkpoint : {};
  const entries: PulumiAdoptionRow[] = [];
  for (const r of Array.isArray(doc.resources) ? doc.resources : []) {
    const row = rowOf(r);
    if (row) entries.push(row);
  }
  const refused: PulumiRefusal[] = [];
  for (const r of Array.isArray(doc.refusals) ? doc.refusals : []) {
    const f = refusalOf(r);
    if (f) refused.push(f);
  }
  return {
    outcome,
    stack: str(doc.stack) ? doc.stack : null,
    digest: str(checkpoint.digest) ? checkpoint.digest : null,
    entries,
    refused,
    said: outcome === "failed" ? `plunge answered an adopt status behold does not know (${status || "none"})` : "",
  };
}

/** The report a page draws: counts by ownership, and every row. */
export function classificationReport(c: PulumiClassification): { claimed: number; total: number; byOwnership: Record<string, number>; entries: PulumiAdoptionRow[] } {
  const byOwnership: Record<string, number> = {};
  for (const e of c.entries) byOwnership[e.ownership] = (byOwnership[e.ownership] ?? 0) + 1;
  return { claimed: c.entries.filter((e) => e.fate === "claimed").length, total: c.entries.length, byOwnership, entries: c.entries };
}

/** What an outcome means, in words. */
export function pulumiOutcomeWords(c: PulumiClassification, confirm: string): string {
  switch (c.outcome) {
    case "classified":
      return `Classified, and nothing was written: plunge waits for a confirm. A person adopts it with \`${confirm}\`.`;
    case "already-adopted":
      return "Already adopted from this checkpoint. plunge wrote nothing.";
    case "refused":
      return "plunge refused the adoption before writing anything, for each reason below. Nothing is offered to confirm until they are settled.";
    case "written":
      return "plunge says it wrote the records. behold never confirms an adoption, so a person did.";
    case "no-view":
      return `This plunge has no \`plunge stack adopt --json\` view, the only answer behold reads. Build plunge from ${PLUNGE_ADOPT_JSON_COMMIT} (INTENTIUS/plunge#17, on integration/engine-ship) or later.${c.said ? ` plunge said: ${c.said}` : ""}`;
    case "unreadable":
      return `behold cannot read plunge's answer: ${c.said}.`;
    default:
      return `plunge did not classify the stack${c.said ? `: ${c.said}` : "."}`;
  }
}

/** Starts plunge with stdout and stderr apart and no stdin. Tests pass their own. */
export type SpawnPlunge = (args: string[], cwd: string, env: Record<string, string>, onStdout: (chunk: string) => void, onStderr: (chunk: string) => void) => { done: Promise<number> };

export const defaultSpawnPlunge: SpawnPlunge = (args, cwd, env, onStdout, onStderr) => {
  assertClassificationOnly(args);
  const proc = spawn("plunge", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.setEncoding("utf8").on("data", onStdout);
  proc.stderr.setEncoding("utf8").on("data", onStderr);
  const done = new Promise<number>((res) => {
    proc.on("error", () => res(127));
    proc.on("close", (c) => res(c ?? 1));
  });
  return { done };
};

/** Where one member's classification runs, and the lines that go with it. */
export interface PulumiPlan {
  member: string;
  dir: string;
  abs: string;
  backend: { url: string; declared: string; onPlunge: boolean };
  stack: string;
  stackFrom: "request" | "export";
  args: string[];
  command: string;
  confirm: string;
  after: string;
  backOut: string;
}

/** The plan for `member`, or why it has none. */
export function pulumiPlanFor(member: WorkspaceMember, askStack?: string): { ok: true; plan: PulumiPlan } | { ok: false; error: string; code: string } {
  if (!member.abs) return { ok: false, error: `${member.name} has no directory here`, code: "adopt" };
  const backend = plungeBackendFor(member.abs);
  if (!backend.ok) return { ok: false, error: backend.why, code: "adopt-backend" };
  const stack = stackFor(member, askStack);
  if (!stack.ok) return { ok: false, error: stack.error, code: "adopt-stack" };
  const b = { url: backend.url, declared: backend.declared, onPlunge: backend.onPlunge };
  return {
    ok: true,
    plan: {
      member: member.name,
      dir: member.dir,
      abs: member.abs,
      backend: b,
      stack: stack.stack,
      stackFrom: stack.from,
      args: plungeClassifyArgv(stack.stack),
      command: classifyCommandLine(member.dir, b.url, stack.stack),
      confirm: confirmCommandLine(member.dir, b.url, stack.stack),
      after: afterConfirmLine(b),
      backOut: backOutLine(member.dir, b.url, stack.stack),
    },
  };
}

/** The offer `GET /api/adopt` lists for a pulumi member. */
export function pulumiOffer(member: WorkspaceMember, preview: boolean): Record<string, unknown> {
  const planned = pulumiPlanFor(member);
  const plan = planned.ok ? planned.plan : undefined;
  return {
    member: member.name,
    kind: member.kind,
    dir: member.dir,
    offered: true,
    engine: PULUMI_ADOPTER.engine,
    gains: PULUMI_ADOPTER.gains,
    limits: PULUMI_ADOPTER.limits,
    stateHint: PULUMI_ADOPTER.state,
    backend: plan ? plan.backend : null,
    stack: plan ? { name: plan.stack, from: plan.stackFrom } : null,
    ...(plan ? { command: plan.command, confirm: plan.confirm, after: plan.after, backOut: plan.backOut } : {}),
    start: !plan
      ? { offered: false, why: planned.ok ? "" : planned.error }
      : preview
        ? { offered: false, why: "adoption is not started in preview mode" }
        : { offered: true },
  };
}

/** Run the classification for `plan` and read it. */
export async function classify(plan: PulumiPlan, spawnPlunge: SpawnPlunge, base: NodeJS.ProcessEnv = process.env): Promise<{ code: number; classification: PulumiClassification }> {
  assertClassificationOnly(plan.args);
  let stdout = "";
  let stderr = "";
  const run = spawnPlunge(plan.args, plan.abs, plungeEnv(base, plan.backend.url), (c) => (stdout += c), (c) => (stderr += c));
  const code = await run.done;
  const classification = code === 127 && !stdout && !stderr ? { ...parsePlungeAdopt("", ""), outcome: "failed" as const, said: "no plunge on PATH" } : parsePlungeAdopt(stdout, stderr);
  return { code, classification };
}

/** A report answer for `plan`, the shape `GET /api/adopt/report` and a finished start both carry. */
export function pulumiReportOf(plan: PulumiPlan, c: PulumiClassification, kind: string): Record<string, unknown> {
  return {
    member: plan.member,
    kind,
    engine: PULUMI_ADOPTER.engine,
    outcome: c.outcome,
    words: pulumiOutcomeWords(c, plan.confirm),
    stack: plan.stack,
    backend: plan.backend.url,
    ...(c.digest ? { digest: c.digest } : {}),
    report: c.entries.length ? classificationReport(c) : null,
    refused: c.refused,
    ...(c.said ? { said: c.said } : {}),
    command: plan.command,
    // Offered only while there is something to confirm.
    ...(c.outcome === "classified" ? { confirm: plan.confirm, after: plan.after } : {}),
    backOut: plan.backOut,
  };
}

/** One classification behold started. */
export interface PulumiAdoptRun {
  id: string;
  member: string;
  kind: string;
  plan: PulumiPlan;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  classification: PulumiClassification | null;
}

/** A started classification, as the page draws it. */
export function pulumiRunOf(run: PulumiAdoptRun): Record<string, unknown> {
  const base = { id: run.id, member: run.member, command: run.plan.command, started_at: run.startedAt, ended_at: run.endedAt, exitCode: run.exitCode };
  if (!run.classification) return { ...base, outcome: "running", words: "plunge is classifying the stack; it writes nothing." };
  return { ...base, ...pulumiReportOf(run.plan, run.classification, run.kind) };
}
