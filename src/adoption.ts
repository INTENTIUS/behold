/**
 * behold#999: "adopt this root". A stock Terraform root member of a declared
 * workspace is offered adoption into choudoufu, the engine tier, through
 * chant's `chant workspace promote <member> --state <file>`
 * (chant packages/core/src/workspace/promote.ts).
 *
 * Two things, and only these:
 *
 * - A read. `GET /api/adopt/report` runs promote's read-only stage, `--dry-run
 *   --json` (src/workspace-reader.ts `readPromoteReport`): chant stages the
 *   change in a throwaway git worktree, runs `choudoufu live-check` and
 *   `choudoufu live-import` without `-approve`, records no gate and leaves the
 *   tree as it was. Its `adoption` field is live-import's report, one entry per
 *   resource instance with its status; behold gives each its fate (claimed, or
 *   left out and why) and computes nothing chant did not say.
 * - A delegated write. `POST /api/adopt/start` starts the gated command itself,
 *   `chant workspace promote <member> --state <file> --json`, the way behold
 *   starts an Op: through the runner's `track`, one command at a time. chant's
 *   gate decides. Before an approval of the patch's digest, promote records a
 *   pending gate and exits 3, and nothing in the tree or the cloud is written.
 *   Only once a person has approved it (`chant approve workspace-promote
 *   <member>`) does the same command apply the patch and run `live-import
 *   -approve`. behold never passes `-approve`, never runs choudoufu itself and
 *   never approves.
 *
 * The state file is the member's own: a file name inside the member's declared
 * directory (default `terraform.tfstate`), never a path from the request.
 * live-import reads a local v4 tfstate; a root on a remote backend pulls one
 * first, to a file git ignores, since promote refuses a member with
 * uncommitted changes.
 *
 * The seam for other engines is the member's kind: {@link ADOPTERS} holds what
 * one kind adopts into. A stock Pulumi stack (kind `pulumi`) is adopted into
 * plunge with `plunge stack adopt` (INTENTIUS/plunge#7, P-L4):
 * src/pulumi-adoption.ts says how, and why its start is plunge's read-only
 * classification and never the confirm. Each route takes a pulumi member
 * ahead of the terraform body below, and the chant floor here is the
 * Terraform half's only: the Pulumi half needs no chant feature.
 *
 * `behold demo terraform-estate` has no state file and no live system, so it
 * serves a recorded report per root (`serve --adopt-recorded <dir>`, one
 * `<member>.json` in the shape promote prints) and offers no start.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Hono } from "hono";
import { stripAnsi } from "./ansi.ts";
import { resolveChant } from "./chant.ts";
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import type { Broadcaster } from "./events.ts";
import type { Runner } from "./public-mode.ts";
import { chantApproveCommand } from "./terragucci-lifecycle.ts";
import type { Workspace, WorkspaceMember } from "./workspace.ts";
import { WorkspaceReadError, type WorkspaceDocument } from "./workspace-reader.ts";
import { classify, defaultSpawnPlunge, PULUMI_ADOPTER, pulumiOffer, pulumiPlanFor, pulumiReportOf, pulumiRunOf, type PulumiAdoptRun, type SpawnPlunge } from "./pulumi-adoption.ts";

/** chant's gate op for a promotion (chant src/op/gate-name.ts WORKSPACE_PROMOTE_GATE_OP). */
export const PROMOTE_GATE_OP = "workspace-promote";
/** promote's exit when it recorded a pending gate (chant PROMOTE_GATED_EXIT). */
export const PROMOTE_GATED_EXIT = 3;
/** How many started adoptions behold keeps in memory. */
export const ADOPT_RUNS_KEPT = 20;
/** The state file a root on the local backend keeps. */
export const DEFAULT_STATE_FILE = "terraform.tfstate";

const STATE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.tfstate$/;
const ID = /^adopt-[a-z0-9-]{1,40}$/;

/** What one member kind adopts into, and what that gives it. */
export interface Adopter {
  kind: string;
  /** The engine the member moves to. */
  engine: string;
  /** What the engine tier gives the member, plainly. */
  gains: string[];
  /** What it does not give, so the offer is not oversold. */
  limits: string[];
  /** How to get the state file the read needs. */
  state: string;
}

/** choudoufu's own account of the engine tier (live/CONCURRENCY.md, live/MARKERS.md, live/MIGRATE.md), per design record INTENTIUS/choudoufu#2258. */
export const TERRAFORM_ADOPTER: Adopter = {
  kind: "terraform",
  engine: "choudoufu",
  gains: [
    "Ownership moves from one state file behind one lock to marker tags on each claimed resource (tofu-estate and tofu-address on AWS) and a per-resource record store.",
    "No lock is held across a run: two applies that change different resources in the estate both land.",
    "The member becomes kind choudoufu: behold draws it from choudoufu's own roster (live-check), each resource with the estate that owns it.",
    "The state file is opened once, read-only, and left as it was. Backing out to stock OpenTofu is possible: its first plan proposes only removing the two marker tags.",
  ],
  limits: [
    "Attributes the provider reads back are last-writer-wins at the cloud API.",
    "A tagged resource the config no longer declares is proposed for removal, so a run planned from an older commit can destroy what a newer run created. choudoufu's docs advise serialising applies against one estate in CI.",
    "Only admitted, taggable types are stamped. MISSING, UNTAGGABLE and UNADMITTED_TYPE resources stay out.",
  ],
  state:
    "live-import reads a local v4 tfstate. A root on a remote backend pulls one first, into the member's directory under a name git ignores (terraform state pull > terraform.tfstate, with *.tfstate in .gitignore): promote refuses a member with uncommitted changes.",
};

/** Member kinds that can be adopted, by kind. */
export const ADOPTERS: Readonly<Record<string, Adopter>> = { terraform: TERRAFORM_ADOPTER, pulumi: PULUMI_ADOPTER };

/** Kinds whose adoption is planned and not built yet, and what it waits on. */
export const ADOPTION_WAITS: Readonly<Record<string, string>> = {};

export function adopterFor(kind: string): Adopter | undefined {
  return Object.prototype.hasOwnProperty.call(ADOPTERS, kind) ? ADOPTERS[kind] : undefined;
}

/** live-import's statuses and what each means for the resource. */
export type AdoptionStatus = "VERIFIED" | "DRIFTED" | "MISSING" | "UNTAGGABLE" | "UNADMITTED_TYPE";
export const FATES: Readonly<Record<AdoptionStatus, { fate: "claimed" | "left-out"; why: string }>> = {
  VERIFIED: { fate: "claimed", why: "verified against the live system; -approve stamps its marker" },
  DRIFTED: { fate: "claimed", why: "verified, but drifted from the state; -approve stamps its marker, and a live-plan after shows the drift" },
  MISSING: { fate: "left-out", why: "could not be verified against the live system, so there is nothing live to carry a marker" },
  UNTAGGABLE: { fate: "left-out", why: "the provider's schema has nowhere to write a marker; its identity is recorded in the record store when one is configured" },
  UNADMITTED_TYPE: { fate: "left-out", why: "choudoufu has no identity knowledge for the type, so it cannot read or stamp it" },
};

export interface AdoptionRow {
  address: string;
  type: string;
  status: string;
  fate: "claimed" | "left-out" | "unknown";
  /** behold's line for the status. */
  why: string;
  /** choudoufu's own reason, verbatim. */
  detail: string;
  liveId: string | null;
}

export interface AdoptionReport {
  estate: string | null;
  state: string | null;
  claimed: number;
  total: number;
  /** Left-out counts by status. */
  leftOut: Record<string, number>;
  entries: AdoptionRow[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** promote's `adoption` field, each entry with its fate. Undefined when the document has none. */
export function adoptionReportOf(doc: WorkspaceDocument): AdoptionReport | undefined {
  const a = doc.adoption;
  if (!isRecord(a) || !Array.isArray(a.entries)) return undefined;
  const entries: AdoptionRow[] = [];
  for (const e of a.entries) {
    if (!isRecord(e) || !str(e.address)) continue;
    const status = str(e.status) ? e.status : "";
    const known = (FATES as Record<string, { fate: "claimed" | "left-out"; why: string }>)[status];
    entries.push({
      address: e.address,
      type: str(e.type) ? e.type : "",
      status,
      fate: known ? known.fate : "unknown",
      why: known ? known.why : `choudoufu gave a status behold does not know (${status || "none"}); its reason is below`,
      detail: typeof e.detail === "string" ? e.detail : "",
      liveId: str(e.liveId) ? e.liveId : null,
    });
  }
  const leftOut: Record<string, number> = {};
  for (const e of entries) if (e.fate !== "claimed") leftOut[e.status || "unknown"] = (leftOut[e.status || "unknown"] ?? 0) + 1;
  return {
    estate: str(a.estate) ? a.estate : null,
    state: str(a.state) ? a.state : null,
    claimed: entries.filter((e) => e.fate === "claimed").length,
    total: entries.length,
    leftOut,
    entries,
  };
}

/** The state file for `member`, from a file name the request may give. Never a path: a name inside the member's directory. */
export function stateFileFor(member: WorkspaceMember, ask?: string): { ok: true; file: string; abs: string; present: boolean } | { ok: false; error: string } {
  const file = ask === undefined || ask === "" ? DEFAULT_STATE_FILE : ask;
  if (!STATE_FILE.test(file)) return { ok: false, error: "state names a .tfstate file in the member's directory, a file name and no path" };
  if (!member.abs) return { ok: false, error: `${member.name} has no directory here` };
  const abs = resolve(member.abs, file);
  const rel = relative(member.abs, abs);
  if (rel.startsWith("..") || rel.includes(sep)) return { ok: false, error: "state names a file in the member's own directory" };
  let present = false;
  try {
    present = statSync(abs).isFile();
  } catch {
    present = false;
  }
  return { ok: true, file, abs, present };
}

/** The gated command a person runs, the one `POST /api/adopt/start` starts. */
export function promoteCommandLine(member: string, state: string): string {
  return `chant workspace promote ${member} --state ${state}`;
}

/** The argv the start runs: promote itself, gated by chant, and never `--dry-run` or anything that skips the gate. */
export function promoteStartArgv(member: string, state: string): string[] {
  return ["workspace", "promote", member, "--state", state, "--json"];
}

/** The approve line for the promotion's gate, bound to the digest when known. */
export function promoteApproveLine(member: string, digest?: string): string {
  return chantApproveCommand(PROMOTE_GATE_OP, member, digest, false);
}

/** What an outcome of promote means, in words. */
export function outcomeWords(outcome: string, member: string, digest?: string, failed?: string): string {
  switch (outcome) {
    case "dry-run":
      return "Staged and checked in a throwaway worktree. No gate was recorded and nothing was written.";
    case "gated":
      return `Gated: nothing was written. chant recorded a pending gate for patch ${digest ?? "(no digest)"}. Approve it with \`${promoteApproveLine(member, digest)}\`, then start adoption again: the same command applies the patch and stamps the markers.`;
    case "applied":
      return "Applied: the approval counted, so chant applied the patch (the member's kind is now choudoufu) and ran live-import -approve. Review the change and commit it.";
    case "checks-failed":
      return `Not gated: ${failed ?? "a check"} failed in the staging worktree. Nothing was written.`;
    case "top-of-ladder":
      return "This member has no rung above it on chant's ladder.";
    default:
      return `promote answered ${outcome}.`;
  }
}

/** One adoption behold started. */
export interface AdoptRunRecord {
  id: string;
  member: string;
  state: string;
  args: string[];
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  stdout: string[];
  stderr: string[];
}

/** A started adoption, as the page draws it. */
export function adoptRunOf(rec: AdoptRunRecord): Record<string, unknown> {
  let doc: Record<string, unknown> | undefined;
  if (rec.exitCode !== null) {
    try {
      const parsed = JSON.parse(rec.stdout.join("\n"));
      if (isRecord(parsed)) doc = parsed;
    } catch {
      doc = undefined;
    }
  }
  const outcome = doc && str(doc.outcome) ? doc.outcome : rec.exitCode === null ? "running" : "refused";
  const digest = doc && str(doc.digest) ? doc.digest : undefined;
  const failed = doc && isRecord(doc.failed) && str(doc.failed.label) ? doc.failed.label : undefined;
  const said = rec.stderr.join("\n").trim().split("\n").slice(-6).join("\n");
  return {
    id: rec.id,
    member: rec.member,
    command: `chant ${rec.args.join(" ")}`,
    started_at: rec.startedAt,
    ended_at: rec.endedAt,
    exitCode: rec.exitCode,
    outcome,
    ...(digest ? { digest } : {}),
    words: outcome === "running" ? "promote is running." : outcome === "refused" ? `chant refused before staging anything${said ? `: ${said}` : "."}` : outcomeWords(outcome, rec.member, digest, failed),
    ...(outcome === "gated" ? { approve: promoteApproveLine(rec.member, digest) } : {}),
    ...(doc ? { report: adoptionReportOf(doc) ?? null } : {}),
  };
}

/** Starts chant with stdout and stderr apart. Tests pass their own. */
export type SpawnChant = (args: string[], cwd: string, onStdout: (chunk: string) => void, onStderr: (chunk: string) => void) => { done: Promise<number> };

const defaultSpawn: SpawnChant = (args, cwd, onStdout, onStderr) => {
  const proc = spawn(resolveChant(cwd).bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.setEncoding("utf8").on("data", onStdout);
  proc.stderr.setEncoding("utf8").on("data", onStderr);
  const done = new Promise<number>((res) => {
    proc.on("error", () => res(127));
    proc.on("close", (c) => res(c ?? 1));
  });
  return { done };
};

export interface AdoptionOptions {
  workspace: () => Workspace | undefined;
  runner: Runner;
  broadcaster: Broadcaster;
  /** The adoption read for the served workspace root. */
  readReport: (root: string, member: string, state: string) => Promise<WorkspaceDocument>;
  preview?: () => boolean;
  /** `serve --adopt-recorded <dir>` (the demo): one recorded `<member>.json` per root, served instead of a live read. */
  recorded?: () => string | undefined;
  chantVersion?: (dir: string) => string | undefined;
  spawn?: SpawnChant;
  /** Starts plunge for a pulumi member's classification. Tests pass their own. */
  spawnPlunge?: SpawnPlunge;
  /** The environment plunge is started from (PULUMI_SKIP_CONFIRMATIONS is always dropped). */
  env?: () => NodeJS.ProcessEnv;
  now?: () => Date;
}

type Refusal = { error: string; code: string; remedy?: string };

/** The recorded report for `member`, when the demo has one. */
export function recordedReport(dir: string, member: string): WorkspaceDocument | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(member)) return undefined;
  const file = join(dir, `${member}.json`);
  if (!existsSync(file)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}

/** Why a recorded report is served, in the answer and on the page. */
export const RECORDED_NOTE =
  "A recorded example: this demo has no state file and no live system, so this is the report promote --dry-run gives for a state of this root, written to the shape chant prints. Nothing was read from a cloud and adoption cannot be started here.";

/**
 * The routes. `GET /api/adopt`: what each member is offered. `GET
 * /api/adopt/report?member=<name>[&state=<file>]`: promote's read-only report.
 * `POST /api/adopt/start` `{member, state?}`: start the gated promote. `GET
 * /api/adopt/runs/:id`: one started adoption.
 */
export function adoptionRoutes(app: Hono, opts: AdoptionOptions): void {
  const runs: AdoptRunRecord[] = [];
  const pulumiRuns: PulumiAdoptRun[] = [];
  const spawnChant = opts.spawn ?? defaultSpawn;
  const spawnPlunge = opts.spawnPlunge ?? defaultSpawnPlunge;
  const plungeEnvBase = () => (opts.env ? opts.env() : process.env);
  const now = () => (opts.now ? opts.now() : new Date());
  const versionOf = (dir: string) => (opts.chantVersion ?? ((d: string) => resolveChant(d).version))(dir);
  const floor = floorFor("adoption report");
  let seq = 0;

  // The Pulumi half needs no chant floor: a pulumi member is refused only without a workspace.
  const noWorkspace = (ws: Workspace | undefined): Refusal | undefined =>
    ws ? undefined : { error: "behold isn't serving a declared chant workspace, and adoption is offered for a member of one.", code: "no-workspace" };
  const closed = (ws: Workspace | undefined): Refusal | undefined => {
    if (!ws) return { error: "behold isn't serving a declared chant workspace, and chant workspace promote adopts a member of one.", code: "no-workspace" };
    if (opts.recorded?.()) return undefined;
    const version = versionOf(ws.root);
    if (!floorMet(floor, version)) return floorRefusal(floor, version);
    return undefined;
  };
  const memberOf = (ws: Workspace, name: unknown): WorkspaceMember | undefined => (typeof name === "string" ? ws.members.find((m) => m.name === name) : undefined);

  app.get("/api/adopt", (c) => {
    const ws = opts.workspace();
    // The answer's refusal is the Terraform half's (its chant floor); a pulumi offer carries its own start and is never held by it.
    const hasTerraform = (ws?.members ?? []).some((m) => m.kind === TERRAFORM_ADOPTER.kind);
    const refusal = hasTerraform || !ws ? closed(ws) : noWorkspace(ws);
    const recorded = opts.recorded?.();
    const offers = (ws?.members ?? []).flatMap((m): Record<string, unknown>[] => {
      const adopter = adopterFor(m.kind);
      if (!adopter) return ADOPTION_WAITS[m.kind] ? [{ member: m.name, kind: m.kind, dir: m.dir, offered: false, waits: ADOPTION_WAITS[m.kind] }] : [];
      if (m.kind === "pulumi") return [{ ...pulumiOffer(m, !!opts.preview?.()), ...(recorded ? { start: { offered: false, why: "the demo serves recorded reports; there is no stack to adopt" } } : {}) }];
      const state = stateFileFor(m);
      const statePath = state.ok ? state.abs : DEFAULT_STATE_FILE;
      const rec = recorded ? recordedReport(recorded, m.name) : undefined;
      const start = recorded
        ? { offered: false, why: "the demo serves a recorded report; there is no state file or live system to adopt" }
        : opts.preview?.()
          ? { offered: false, why: "adoption is not started in preview mode" }
          : state.ok && !state.present
            ? { offered: false, why: `no ${DEFAULT_STATE_FILE} in ${m.dir}. ${adopter.state}` }
            : { offered: true };
      return [
        {
          member: m.name,
          kind: m.kind,
          dir: m.dir,
          offered: true,
          engine: adopter.engine,
          gains: adopter.gains,
          limits: adopter.limits,
          stateHint: adopter.state,
          state: { file: DEFAULT_STATE_FILE, present: state.ok ? state.present : false },
          command: promoteCommandLine(m.name, statePath),
          approve: promoteApproveLine(m.name),
          recorded: !!rec,
          start,
        },
      ];
    });
    return c.json({ refusal: refusal ?? null, recorded: recorded ? RECORDED_NOTE : null, offers }, 200, { "cache-control": "no-store" });
  });

  app.get("/api/adopt/report", async (c) => {
    const ws = opts.workspace();
    const pulumiMember = ws ? memberOf(ws, c.req.query("member")) : undefined;
    if (pulumiMember?.kind === "pulumi") {
      const planned = pulumiPlanFor(pulumiMember, c.req.query("stack"));
      if (!planned.ok) return c.json({ error: planned.error, code: planned.code, remedy: PULUMI_ADOPTER.state }, planned.code === "adopt" ? 400 : 422);
      const { classification } = await classify(planned.plan, spawnPlunge, plungeEnvBase());
      return c.json(pulumiReportOf(planned.plan, classification, pulumiMember.kind), 200, { "cache-control": "no-store" });
    }
    const refusal = closed(ws);
    if (refusal) return c.json(refusal, refusal.code === "no-workspace" ? 404 : 409);
    const member = memberOf(ws!, c.req.query("member"));
    if (!member) return c.json({ error: "member names a member of the workspace", code: "adopt" }, 400);
    const adopter = adopterFor(member.kind);
    if (!adopter) return c.json({ error: ADOPTION_WAITS[member.kind] ?? `${member.name} is kind ${member.kind}, which behold offers no adoption for.`, code: "adopt-kind" }, 422);
    const recorded = opts.recorded?.();
    let doc: WorkspaceDocument | undefined;
    let statePath: string;
    if (recorded) {
      doc = recordedReport(recorded, member.name);
      if (!doc) return c.json({ error: `the demo has no recorded report for ${member.name}`, code: "adopt-recorded" }, 404);
      statePath = DEFAULT_STATE_FILE;
    } else {
      const state = stateFileFor(member, c.req.query("state"));
      if (!state.ok) return c.json({ error: state.error, code: "adopt" }, 400);
      if (!state.present) return c.json({ error: `no ${state.file} in ${member.dir}.`, code: "adopt-state", remedy: adopter.state }, 422);
      statePath = state.abs;
      try {
        doc = await opts.readReport(ws!.root, member.name, state.abs);
      } catch (err) {
        if (err instanceof WorkspaceReadError) return c.json(err.refusal, 422);
        throw err;
      }
    }
    const outcome = str(doc.outcome) ? doc.outcome : "unknown";
    const digest = str(doc.digest) ? doc.digest : undefined;
    const failed = isRecord(doc.failed) ? { label: str(doc.failed.label) ? doc.failed.label : "", output: typeof doc.failed.output === "string" ? stripAnsi(doc.failed.output) : "" } : undefined;
    const report = adoptionReportOf(doc);
    return c.json(
      {
        member: member.name,
        kind: member.kind,
        engine: adopter.engine,
        ...(recorded ? { recorded: RECORDED_NOTE } : {}),
        outcome,
        words: outcomeWords(outcome, member.name, digest, failed?.label),
        ...(digest ? { digest } : {}),
        ...(failed ? { failed } : {}),
        report: report ?? null,
        ...(report ? {} : { absent: outcome === "checks-failed" ? "live-import did not run: an earlier check failed." : "promote printed no adoption report." }),
        command: promoteCommandLine(member.name, statePath),
        approve: promoteApproveLine(member.name, digest),
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  app.post("/api/adopt/start", async (c) => {
    const ws = opts.workspace();
    const early = noWorkspace(ws);
    if (early) return c.json(early, 404);
    if (opts.preview?.()) return c.json({ error: "adoption is not started in preview mode", code: "preview" }, 403);
    if (opts.recorded?.()) return c.json({ error: "the demo serves a recorded report; there is no state file or live system to adopt", code: "adopt-recorded" }, 409);
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json();
      body = isRecord(parsed) ? parsed : {};
    } catch {
      return c.json({ error: "the body is JSON: {member, state?} or, for a pulumi member, {member, stack?}", code: "adopt" }, 400);
    }
    const member = memberOf(ws!, body.member);
    if (!member) return c.json({ error: "member names a member of the workspace", code: "adopt" }, 400);
    if (member.kind === "pulumi") {
      // The Pulumi half: plunge's classification, never its confirm (src/pulumi-adoption.ts).
      const planned = pulumiPlanFor(member, typeof body.stack === "string" ? body.stack : undefined);
      if (!planned.ok) return c.json({ error: planned.error, code: planned.code, remedy: PULUMI_ADOPTER.state }, planned.code === "adopt" ? 400 : 422);
      const plan = planned.plan;
      const id = `adopt-${(++seq).toString(36)}-${now().getTime().toString(36)}`;
      const prec: PulumiAdoptRun = { id, member: member.name, kind: member.kind, plan, startedAt: now().toISOString(), endedAt: null, exitCode: null, classification: null };
      const started = opts.runner.track(`plunge stack adopt ${plan.stack} (${member.name}, classify only)`, async (io) => {
        io.line(`▶ ${plan.command}`);
        const { code, classification } = await classify(plan, spawnPlunge, plungeEnvBase());
        prec.exitCode = code;
        prec.classification = classification;
        prec.endedAt = now().toISOString();
        io.line(String(pulumiRunOf(prec).words));
        opts.broadcaster.emit("adopt-run", id);
        // Without --yes plunge exits non-zero once it has listed everything: that is its gate holding, not a failure.
        return classification.outcome === "classified" || classification.outcome === "already-adopted" ? 0 : code || 1;
      });
      if (!started) return c.json({ error: `busy: ${opts.runner.running} is running`, code: "busy" }, 409);
      pulumiRuns.unshift(prec);
      pulumiRuns.splice(ADOPT_RUNS_KEPT);
      return c.json({ started: true, id, command: plan.command, confirm: plan.confirm }, 202);
    }
    const refusal = closed(ws);
    if (refusal) return c.json(refusal, refusal.code === "no-workspace" ? 404 : 409);
    const adopter = adopterFor(member.kind);
    if (!adopter) return c.json({ error: ADOPTION_WAITS[member.kind] ?? `${member.name} is kind ${member.kind}, which behold offers no adoption for.`, code: "adopt-kind" }, 422);
    const state = stateFileFor(member, typeof body.state === "string" ? body.state : undefined);
    if (!state.ok) return c.json({ error: state.error, code: "adopt" }, 400);
    if (!state.present) return c.json({ error: `no ${state.file} in ${member.dir}.`, code: "adopt-state", remedy: adopter.state }, 422);
    const args = promoteStartArgv(member.name, state.abs);
    const id = `adopt-${(++seq).toString(36)}-${now().getTime().toString(36)}`;
    const rec: AdoptRunRecord = { id, member: member.name, state: state.abs, args, startedAt: now().toISOString(), endedAt: null, exitCode: null, stdout: [], stderr: [] };
    const root = ws!.root;
    const nudge = () => opts.broadcaster.emit("adopt-run", id);
    const started = opts.runner.track(`chant workspace promote ${member.name}`, async (io) => {
      io.line(`▶ chant ${args.join(" ")}`);
      const run = spawnChant(
        args,
        root,
        (chunk) => rec.stdout.push(chunk),
        (chunk) => {
          const text = stripAnsi(chunk);
          rec.stderr.push(text);
          for (const l of text.split("\n")) if (l.trim()) io.line(l);
          nudge();
        },
      );
      const code = await run.done;
      rec.stdout = [rec.stdout.join("")];
      rec.exitCode = code;
      rec.endedAt = now().toISOString();
      const view = adoptRunOf(rec);
      io.line(String(view.words));
      nudge();
      // A gated promote exits 3, which is the gate holding, not a failure of the run.
      return code === PROMOTE_GATED_EXIT ? 0 : code;
    });
    if (!started) return c.json({ error: `busy: ${opts.runner.running} is running`, code: "busy" }, 409);
    runs.unshift(rec);
    runs.splice(ADOPT_RUNS_KEPT);
    return c.json({ started: true, id, command: `chant ${args.join(" ")}` }, 202);
  });

  app.get("/api/adopt/runs/:id", (c) => {
    const id = c.req.param("id");
    const prec = ID.test(id) ? pulumiRuns.find((r) => r.id === id) : undefined;
    if (prec) return c.json(pulumiRunOf(prec), 200, { "cache-control": "no-store" });
    const rec = ID.test(id) ? runs.find((r) => r.id === id) : undefined;
    if (!rec) return c.json({ absent: `behold has no adoption ${id}: it keeps the last ${ADOPT_RUNS_KEPT} it started, in memory.` }, 404, { "cache-control": "no-store" });
    return c.json(adoptRunOf(rec), 200, { "cache-control": "no-store" });
  });
}
