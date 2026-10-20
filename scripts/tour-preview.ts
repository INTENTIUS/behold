// `npm run preview:tour` (#711): the terralith tour in the kiosk, local only.
// It writes a reports directory the way terragucci's demo loop wrote one for
// its terralith scenario (terragucci#1131, stack/demo.sh before #1158), steps
// demo.json through the cycle's five beats, and serves it with
// `behold serve <checkout> --terragucci <dir> --public` on 127.0.0.1, so
// http://127.0.0.1:4714/kiosk plays the six chapters. No Docker, no forge, no
// cloud: every file is written here, by the shapes terragucci writes
// (estates.json, rosters, migration records and progress.jsonl, report index
// rows, report.json and plan.json, runs/index.json, demo.json).
//
// Nothing here is a recording. The resources are the thin terralith's 14
// (terragucci#1155), the beats and steps are the driver's, and each step is
// written when the preview reaches it, so every time in the files is real.
//
//   npm run preview:tour                    loop the cycle, a step every 6 s
//   npm run preview:tour -- --step-ms 2000  faster
//   npm run preview:tour -- --port 4800 --dir /tmp/tour
//
// The kiosk's frame draws the served checkout's .tf files, so the terraform
// lexicon peers have to resolve (scripts/install-peers.sh links them).
//
// `TourCycle` is exported for a script that wants to step it itself (a
// headless check of each chapter): `new TourCycle(dir).next()` writes the next
// step and returns it.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "demo";
const REPO = `${OWNER}/demo-terralith`;
const TEAM_REPO = `${OWNER}/demo-terralith-team-b`;
const FORGE = "http://forgejo:3000";
const P = `forgejo:3000/${REPO}`;
const PT = `forgejo:3000/${TEAM_REPO}`;

interface Res {
  address: string;
  type: string;
  root: "shared" | "team-b";
  /** An inline policy: untaggable, it moves with its role. */
  follows?: string;
}

/** The thin terralith (terragucci#1155): a network and three teams, 14 instances; team B's five carve out. */
const RESOURCES: Res[] = [
  { address: "aws_vpc.main", type: "aws_vpc", root: "shared" },
  { address: "aws_subnet.main", type: "aws_subnet", root: "shared" },
  { address: "aws_security_group.main", type: "aws_security_group", root: "shared" },
  { address: "aws_iam_role.team_a_role", type: "aws_iam_role", root: "shared" },
  { address: "aws_iam_role_policy.team_a_inline", type: "aws_iam_role_policy", root: "shared", follows: "aws_iam_role.team_a_role" },
  { address: "aws_cloudwatch_log_group.team_a", type: "aws_cloudwatch_log_group", root: "shared" },
  { address: "aws_iam_role.team_c_role", type: "aws_iam_role", root: "shared" },
  { address: "aws_iam_role_policy.team_c_inline", type: "aws_iam_role_policy", root: "shared", follows: "aws_iam_role.team_c_role" },
  { address: "aws_cloudwatch_log_group.team_c", type: "aws_cloudwatch_log_group", root: "shared" },
  { address: "aws_iam_role.team_b_role", type: "aws_iam_role", root: "team-b" },
  { address: "aws_iam_role_policy.team_b_inline", type: "aws_iam_role_policy", root: "team-b", follows: "aws_iam_role.team_b_role" },
  { address: "aws_iam_role.team_b_worker[0]", type: "aws_iam_role", root: "team-b" },
  { address: "aws_iam_role.team_b_worker[1]", type: "aws_iam_role", root: "team-b" },
  { address: "aws_cloudwatch_log_group.team_b", type: "aws_cloudwatch_log_group", root: "team-b" },
];

const hex = (seed: string): string => {
  let h = 2166136261;
  let out = "";
  while (out.length < 40) {
    for (const ch of seed + out.length) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
};

/** demo.json's times, as the driver writes them: UTC to the second. */
const secs = (d: Date): string => `${d.toISOString().slice(0, 19)}Z`;

/** One demo.json write: the beat, the step, the driver's label and next action. */
export interface TourStep {
  beat: "stock" | "adopt" | "split" | "team" | "cross" | null;
  step: string;
  label: string;
  next: string | null;
  /** What lands with this step, before demo.json is written. */
  lands?: Land[];
}

type Land =
  | "stock-apply"
  | "adopt-plan"
  | "adopt-waiting"
  | "adopt-write"
  | "split-plan"
  | "split-waiting"
  | "split-write"
  | "team-plan"
  | "team-apply"
  | "cross-plan"
  | "wave1-start"
  | "wave1-end"
  | "wave2-start"
  | "wave2-end";

/** The cycle as the driver writes it (stack/demo.sh scenario_terralith). */
export const STEPS: TourStep[] = [
  { beat: "stock", step: "applying", label: "The driver pushes the cycle's stock shared root to main. The push's run applies it as wave 1.", next: "follow the stock apply" },
  { beat: "stock", step: "applied", label: "One shared root holds 14 resources in one state file.", next: "open the adopt pull request", lands: ["stock-apply"] },
  { beat: "adopt", step: "pull-request", label: "A pull request swaps the shared root's backend for a live block and adds a backends migration.", next: "wait for the plan note" },
  { beat: "adopt", step: "planned", label: "The plan note shows the migration's proof: no change.", next: "merge pull request 41", lands: ["adopt-plan"] },
  { beat: "adopt", step: "merged", label: "Merged. Wave 1 runs the migration.", next: "follow the waves" },
  { beat: "adopt", step: "waiting", label: "The migration waits for a person to approve its digest.", next: "approve migration adopt", lands: ["adopt-waiting"] },
  { beat: "adopt", step: "approved", label: "The reviewer approves the digest.", next: "post /terragucci apply on pull request 41" },
  { beat: "adopt", step: "resumed", label: "choudoufu reads the state once and stamps each resource.", next: "follow the waves" },
  { beat: "adopt", step: "applied", label: "Adopted: every resource wears its owner's tags, and the state file is as it was.", next: "open the split pull request", lands: ["adopt-write"] },
  { beat: "split", step: "pull-request", label: "A pull request carves team B out of the shared root and adds a moves migration.", next: "wait for the plan note" },
  { beat: "split", step: "planned", label: "The plan note shows the migration's proof: both roots plan no change.", next: "merge pull request 42", lands: ["split-plan"] },
  { beat: "split", step: "merged", label: "Merged. Wave 1 runs the migration.", next: "follow the waves" },
  { beat: "split", step: "waiting", label: "The migration waits for a person to approve its digest.", next: "approve migration split", lands: ["split-waiting"] },
  { beat: "split", step: "approved", label: "The reviewer approves the digest.", next: "post /terragucci apply on pull request 42" },
  { beat: "split", step: "resumed", label: "choudoufu rewrites the owner tag of each of team B's resources.", next: "follow the waves" },
  { beat: "split", step: "applied", label: "Team B has an estate of its own. Both roots plan no change.", next: "push team B's root to its own repository", lands: ["split-write"] },
  { beat: "team", step: "pull-request", label: "Team B adds one action to an inline policy in its own repository.", next: "wait for the plan note" },
  { beat: "team", step: "planned", label: "The plan covers team B's cone only.", next: "merge pull request 3", lands: ["team-plan"] },
  { beat: "team", step: "merged", label: "Merged. Team B's root applies.", next: "follow the waves" },
  { beat: "team", step: "applied", label: "Applied in team B's estate alone.", next: "copy team B's root back to demo-terralith", lands: ["team-apply"] },
  { beat: "cross", step: "pull-request", label: "The shared root publishes log_retention_days, and team B reads it.", next: "wait for the plan note" },
  { beat: "cross", step: "planned", label: "Wave 1 plans the shared root; wave 2 plans team B on the shared root's planned value.", next: "merge pull request 43", lands: ["cross-plan"] },
  { beat: "cross", step: "merged", label: "Merged.", next: "follow the waves" },
  { beat: "cross", step: "applying", label: "Wave 1 applies the shared root.", next: "follow the waves", lands: ["wave1-start"] },
  { beat: "cross", step: "applying", label: "Wave 2 plans team B on the value wave 1 recorded, and applies it.", next: "follow the waves", lands: ["wave1-end", "wave2-start"] },
  { beat: "cross", step: "applied", label: "Applied across estates, each in its own wave.", next: "reset", lands: ["wave2-end"] },
  { beat: null, step: "reset", label: "Outside the pipeline, the driver destroys this cycle's resources in the background.", next: "start the next cycle" },
];

interface Row {
  project: string;
  commit: string;
  stage: "tf-plan" | "tf-apply";
  wave?: number;
  finished: string;
  path: string;
  pull_request?: string;
  pull_request_url?: string;
  job_url: string;
  approval?: "approved" | "not-required" | "waiting";
  roots: number;
  groups: number;
  totals: { create: number; update: number; replace: number; delete: number };
  refused: number;
  destroys: unknown[];
  changed: number;
}

interface PlannedRoot {
  path: string;
  /** Each instance and its actions. */
  changes: { address: string; type: string; actions: string[] }[];
  reads?: { upstream: string; data: string; outputs: "planned" | "applied" }[];
  outputs?: Record<string, { before: unknown; after: unknown }>;
}

/** A terralith cycle written step by step into a reports directory, every time the wall clock's. */
export class TourCycle {
  readonly dir: string;
  readonly cycle: number;
  private i = -1;
  private startedAt = "";
  private rows: Row[] = [];
  private files = new Map<string, unknown>();
  private estates = new Map<string, { estate: string; count: number; at: string; project: string; root: string; roster: string }>();
  private migrations: { name: string; project: string; record: Record<string, unknown>; lines: Record<string, unknown>[] }[] = [];
  private runs: Record<string, unknown>[] = [];
  private job = 3600;
  private repo = REPO;
  private pull: number | null = null;
  private commit: string | null = null;

  constructor(dir: string, cycle = 7) {
    this.dir = dir;
    this.cycle = cycle;
  }

  get prefix(): string {
    return `tl${this.cycle}`;
  }

  /** The step written last, or null before the first. */
  get current(): TourStep | null {
    return this.i >= 0 ? STEPS[this.i]! : null;
  }

  /** Write the next step; past the reset, a new cycle starts. Returns the step written. */
  async next(): Promise<TourStep> {
    if (this.i >= STEPS.length - 1) this.restart(this.cycle + 1);
    this.i++;
    const s = STEPS[this.i]!;
    if (this.i === 0) this.startedAt = secs(new Date());
    if (s.beat === "team") this.repo = TEAM_REPO;
    else if (s.beat) this.repo = REPO;
    if (s.step === "pull-request") {
      this.pull = s.beat === "team" ? 3 : s.beat === "adopt" ? 41 : s.beat === "split" ? 42 : 43;
      this.commit = hex(`${this.cycle}-${s.beat}-head`);
    }
    if (s.beat === "stock") this.commit = hex(`${this.cycle}-stock`);
    for (const l of s.lands ?? []) await this.land(l);
    this.write(s);
    return s;
  }

  /** Step until `pred` holds for the step just written. */
  async until(pred: (s: TourStep) => boolean): Promise<TourStep> {
    for (let n = 0; n < STEPS.length + 1; n++) {
      const s = await this.next();
      if (pred(s)) return s;
    }
    throw new Error("no such step");
  }

  private restart(cycle: number): void {
    (this as { cycle: number }).cycle = cycle;
    this.i = -1;
    this.rows = [];
    this.migrations = [];
    this.runs = [];
    this.pull = null;
    this.commit = null;
    this.repo = REPO;
    // The previous cycle's estates stay in estates.json under their own prefix, as terragucci's do.
  }

  private now(): string {
    return new Date().toISOString();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private jobUrl(repo: string): string {
    this.job += 1;
    return `${FORGE}/${repo}/actions/runs/${this.job}`;
  }

  private liveId(r: Res): string {
    // As AWS names them: a role or a log group by its name, the network's by an id of its kind.
    const name = r.address.replace(/^[a-z0-9_]+\./, "").replace(/\[(\d+)\]$/, "-$1").replace(/_/g, "-");
    const id = { aws_vpc: "vpc", aws_subnet: "subnet", aws_security_group: "sg" }[r.type];
    return id ? `${id}-0${hex(this.prefix + r.address).slice(0, 16)}` : `${this.prefix}-${name}`;
  }

  private estate(root: "shared" | "team-b"): string {
    return `${this.prefix}-${root}`;
  }

  private roster(name: string, project: string, root: string, list: Res[], marked: boolean, at: string): void {
    const key = `estates/${name}/roster.json`;
    this.files.set(key, {
      estate: name,
      at,
      resources: list.map((r) => ({ address: r.address, type: r.type, ...(r.follows ? { follows: r.follows } : { live_id: this.liveId(r) }), marked: marked && !r.follows })),
    });
    this.estates.set(name, { estate: name, count: list.length, at, project, root, roster: key });
  }

  /** A report row, its report.json and each root's plan.json. */
  private report(project: string, repo: string, stage: "tf-plan" | "tf-apply", commit: string, roots: PlannedRoot[], o: { wave?: number; pull?: number; approval?: Row["approval"]; started?: string; waves?: { number: number; roots: string[] }[] } = {}): Row {
    const finished = this.now();
    const d = new Date(finished);
    const path = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${commit}/${stage}${o.wave ? `-wave-${o.wave}` : ""}`;
    const job_url = this.jobUrl(repo);
    const totals = { create: 0, update: 0, replace: 0, delete: 0 };
    const reportRoots = roots.map((r) => {
      const counts: Record<string, number> = {};
      for (const c of r.changes) {
        const a = c.actions.join("-") === "delete-create" ? "replace" : c.actions[0]!;
        counts[a] = (counts[a] ?? 0) + 1;
        if (a in totals) totals[a as keyof typeof totals]++;
      }
      const planKey = `plans/${r.path.replace(/\//g, "_") || "root"}.json`;
      this.files.set(`${project}/${path}/${planKey}`, {
        format_version: "1.2",
        resource_changes: r.changes.map((c) => ({ address: c.address, mode: "managed", type: c.type, name: c.address.split(".")[1]!.replace(/\[\d+\]$/, ""), change: { actions: c.actions } })),
        output_changes: Object.fromEntries(Object.entries(r.outputs ?? {}).map(([k, v]) => [k, { actions: [v.before === null ? "create" : "update"], before: v.before, after: v.after, after_unknown: false, after_sensitive: false }])),
      });
      return {
        path: r.path,
        status: "planned",
        plan_digest: `sha256:${hex(`${commit}${r.path}${stage}`)}`,
        counts,
        plan: { json: planKey },
        changes: [],
        highlights: [],
        fold: {},
        why: [],
        ...(r.reads ? { reads: r.reads } : {}),
      };
    });
    const pull = o.pull ? String(o.pull) : undefined;
    const pullUrl = o.pull ? `${FORGE}/${repo}/pulls/${o.pull}` : undefined;
    this.files.set(`${project}/${path}/report.json`, {
      schema: "terragucci.report/v1",
      minor: 40,
      run: { project, commit, stage, ...(o.wave ? { wave: o.wave } : {}), binary: "choudoufu", runtime: "forgejo", started: o.started ?? finished, finished, job_url, ...(pull ? { pull_request: pull, pull_request_url: pullUrl } : {}) },
      change_set: `sha256:${hex(commit + stage)}`,
      unit: "instance",
      units: roots.reduce((n, r) => n + r.changes.length, 0),
      totals,
      groups: [],
      roots: reportRoots,
      waves: (o.waves ?? [{ number: o.wave ?? 1, roots: roots.map((r) => r.path) }]).map((w) => ({ number: w.number, roots: w.roots, set_digest: null, approval: o.approval === "approved" ? "approved" : "not-required" })),
      named: [],
      holes: [],
      redaction: {},
    });
    const row: Row = {
      project,
      commit,
      stage,
      ...(o.wave ? { wave: o.wave } : {}),
      finished,
      path,
      ...(pull ? { pull_request: pull, pull_request_url: pullUrl } : {}),
      job_url,
      ...(stage === "tf-apply" ? { approval: o.approval ?? "not-required" } : {}),
      roots: roots.length,
      groups: 0,
      totals,
      refused: 0,
      destroys: [],
      changed: reportRoots.filter((r) => Object.keys(r.counts).some((a) => a !== "no-op")).length,
    };
    this.rows.push(row);
    return row;
  }

  private noop(root: "shared" | "team-b", list = RESOURCES.filter((r) => r.root === root)): PlannedRoot {
    return { path: root, changes: list.map((r) => ({ address: r.address, type: r.type, actions: ["no-op"] })) };
  }

  private migration(name: string, record: Record<string, unknown>): void {
    const m = this.migrations.find((x) => x.name === name);
    if (m) m.record = record;
    else this.migrations.push({ name, project: P, record, lines: [] });
  }

  private async land(l: Land): Promise<void> {
    const stockCommit = hex(`${this.cycle}-stock`);
    const merge = (beat: string) => hex(`${this.cycle}-${beat}-merge`);
    const shared = RESOURCES.filter((r) => r.root === "shared");
    const teamB = RESOURCES.filter((r) => r.root === "team-b");
    const stateKey = `s3://demo-terralith-state/${this.prefix}-shared.tfstate`;
    const versionId = `${hex(`${this.cycle}-state`).slice(0, 32)}`;
    switch (l) {
      case "stock-apply": {
        // The push's run applies the stock root: every resource created, its roster written beside the report.
        const row = this.report(P, REPO, "tf-apply", stockCommit, [{ path: "shared", changes: RESOURCES.map((r) => ({ address: r.address, type: r.type, actions: ["create"] })) }], { wave: 1 });
        this.roster("shared", P, "shared", RESOURCES, false, row.finished);
        this.runs.push(this.run(REPO, "push", stockCommit, null, [["apply-wave-1", row.finished, row.finished]]));
        return;
      }
      case "adopt-plan":
        this.report(P, REPO, "tf-plan", this.commit!, [this.noop("shared", RESOURCES)], { pull: 41 });
        return;
      case "adopt-waiting":
      case "split-waiting": {
        const adopt = l === "adopt-waiting";
        this.migration(adopt ? "adopt" : "split", this.record(adopt ? "adopt" : "split", "waiting", { stateKey, versionId }));
        return;
      }
      case "adopt-write": {
        // live-import stamps every resource in well under a second; the inline policies are untaggable and skipped.
        const m = this.migrations.find((x) => x.name === "adopt")!;
        const total = RESOURCES.length;
        const c = { moved: 0, stamped: 0, refused: 0, skipped: 0, left: total };
        for (const r of RESOURCES) {
          await this.sleep(15);
          const outcome = r.follows ? "skipped" : "stamped";
          c[outcome]++;
          c.left--;
          m.lines.push({ at: this.now(), estate_from: "", estate_to: this.estate("shared"), address: r.address, ...(r.follows ? { follows: r.follows } : { live_id: this.liveId(r) }), outcome, migration: "adopt", counts: { ...c } });
        }
        const finished = this.now();
        m.record = { ...this.record("adopt", "applied", { stateKey, versionId }), finished, commit: merge("adopt"), progress: { ...c } };
        this.roster(this.estate("shared"), P, "shared", RESOURCES, true, finished);
        const row = this.report(P, REPO, "tf-apply", merge("adopt"), [this.noop("shared", RESOURCES)], { wave: 1 });
        this.runs.push(this.run(REPO, "push", merge("adopt"), 41, [["apply-wave-1", row.finished, row.finished]]));
        return;
      }
      case "split-plan":
        this.report(P, REPO, "tf-plan", this.commit!, [this.noop("shared"), this.noop("team-b")], { pull: 42 });
        return;
      case "split-write": {
        // live-mv retags each of team B's taggable resources, about a second apart; the inline policy follows its role.
        const m = this.migrations.find((x) => x.name === "split")!;
        const total = teamB.length;
        const c = { moved: 0, stamped: 0, refused: 0, skipped: 0, left: total };
        for (const r of teamB) {
          await this.sleep(r.follows ? 5 : 400);
          c.moved++;
          c.left--;
          m.lines.push({ at: this.now(), estate_from: this.estate("shared"), estate_to: this.estate("team-b"), address: r.address, ...(r.follows ? { follows: r.follows } : { live_id: this.liveId(r) }), outcome: "moved", migration: "split", counts: { ...c } });
          this.flush();
        }
        const finished = this.now();
        m.record = { ...this.record("split", "applied", { stateKey, versionId }), finished, commit: merge("split"), progress: { ...c } };
        this.roster(this.estate("shared"), P, "shared", shared, true, finished);
        this.roster(this.estate("team-b"), P, "team-b", teamB, true, finished);
        // The post-write plans, the proof nothing was recreated: both roots plan no change.
        const row = this.report(P, REPO, "tf-apply", merge("split"), [this.noop("shared"), this.noop("team-b")], { wave: 1 });
        this.runs.push(this.run(REPO, "push", merge("split"), 42, [["apply-wave-1", row.finished, row.finished]]));
        return;
      }
      case "team-plan": {
        // In team B's own repository, its root at the top: one inline policy changes.
        const changes = teamB.map((r) => ({ address: r.address, type: r.type, actions: r.address === "aws_iam_role_policy.team_b_inline" ? ["update"] : ["no-op"] }));
        this.report(PT, TEAM_REPO, "tf-plan", this.commit!, [{ path: ".", changes }], { pull: 3 });
        return;
      }
      case "team-apply": {
        const changes = teamB.map((r) => ({ address: r.address, type: r.type, actions: r.address === "aws_iam_role_policy.team_b_inline" ? ["update"] : ["no-op"] }));
        const row = this.report(PT, TEAM_REPO, "tf-apply", merge("team"), [{ path: ".", changes }], { wave: 1 });
        this.roster(this.estate("team-b"), PT, ".", teamB, true, row.finished);
        this.runs.push(this.run(TEAM_REPO, "push", merge("team"), 3, [["apply-wave-1", row.finished, row.finished]]));
        return;
      }
      case "cross-plan": {
        const logs = (r: Res) => r.type === "aws_cloudwatch_log_group";
        this.report(
          P,
          REPO,
          "tf-plan",
          this.commit!,
          [
            { path: "shared", changes: shared.map((r) => ({ address: r.address, type: r.type, actions: logs(r) ? ["update"] : ["no-op"] })), outputs: { log_retention_days: { before: null, after: 14 } } },
            { path: "team-b", changes: teamB.map((r) => ({ address: r.address, type: r.type, actions: logs(r) ? ["update"] : ["no-op"] })), reads: [{ upstream: "shared", data: "data.terraform_estate_outputs.platform", outputs: "planned" }] },
          ],
          { pull: 43, waves: [{ number: 1, roots: ["shared"] }, { number: 2, roots: ["team-b"] }] },
        );
        return;
      }
      case "wave1-start":
        this.runs.push(this.run(REPO, "push", merge("cross"), 43, [["apply-wave-1", this.now(), null]]));
        return;
      case "wave1-end": {
        const logs = (r: Res) => r.type === "aws_cloudwatch_log_group";
        const row = this.report(P, REPO, "tf-apply", merge("cross"), [{ path: "shared", changes: shared.map((r) => ({ address: r.address, type: r.type, actions: logs(r) ? ["update"] : ["no-op"] })), outputs: { log_retention_days: { before: null, after: 14 } } }], { wave: 1 });
        this.roster(this.estate("shared"), P, "shared", shared, true, row.finished);
        this.job1(row.finished);
        return;
      }
      case "wave2-start":
        await this.sleep(300);
        this.job2(this.now(), null);
        return;
      case "wave2-end": {
        // terragucci#1145: wave 2's apply report names no roots; the tour lights the pull request's plan of wave 2 instead.
        const row = this.report(P, REPO, "tf-apply", merge("cross"), [], { wave: 2, waves: [{ number: 2, roots: [] }] });
        this.roster(this.estate("team-b"), P, "team-b", teamB, true, row.finished);
        const run = this.runs[this.runs.length - 1]!;
        const j = (run.jobs as Record<string, unknown>[]).find((x) => x.name === "apply-wave-2")!;
        j.ended_at = row.finished;
        j.status = "success";
        run.status = "success";
        run.ended_at = row.finished;
        return;
      }
    }
  }

  private job1(ended: string): void {
    const run = this.runs[this.runs.length - 1]!;
    const j = (run.jobs as Record<string, unknown>[]).find((x) => x.name === "apply-wave-1")!;
    j.ended_at = ended;
    j.status = "success";
  }

  private job2(started: string, ended: string | null): void {
    const run = this.runs[this.runs.length - 1]!;
    (run.jobs as Record<string, unknown>[]).push({ id: this.job + 1000, name: "apply-wave-2", needs: ["apply-wave-1"], status: ended ? "success" : "running", started_at: started, ended_at: ended });
  }

  private run(repo: string, event: string, commit: string, pull: number | null, jobs: [string, string, string | null][]): Record<string, unknown> {
    const id = 400 + this.runs.length + this.cycle * 20;
    return {
      id,
      title: `run ${id}`,
      event,
      trigger: "merge",
      ref: "main",
      commit,
      pull,
      cycle: this.cycle,
      scenario: "terralith",
      repo,
      tool: "terralith",
      status: jobs.every((j) => j[2]) ? "success" : "running",
      created_at: jobs[0]![1],
      started_at: jobs[0]![1],
      ended_at: jobs.every((j) => j[2]) ? jobs[jobs.length - 1]![2] : null,
      jobs: jobs.map(([name, s, e], k) => ({ id: id * 10 + k, name, needs: [], status: e ? "success" : "running", started_at: s, ended_at: e })),
    };
  }

  private record(name: "adopt" | "split", status: string, o: { stateKey: string; versionId: string }): Record<string, unknown> {
    const teamB = RESOURCES.filter((r) => r.root === "team-b");
    const base = { schema: "terragucci.migration/v1", name, file: `migrations/${name}.yml`, file_digest: `sha256:${hex(name)}`, moves: [], digest: `sha256:${hex(`${this.cycle}${name}digest`)}`, status, ...(status !== "waiting" ? { approved_by: "reviewer" } : {}) };
    if (name === "adopt") {
      return {
        ...base,
        change: "adopt",
        stamps: RESOURCES.map((r) => ({ root: "shared", estate: this.estate("shared"), address: r.address, type: r.type, status: r.follows ? "UNTAGGABLE" : "VERIFIED", ...(r.follows ? {} : { live_id: this.liveId(r) }) })),
        backends: [{ root: "shared", from: o.stateKey }],
        roots: [
          {
            root: "shared",
            backend: "live",
            before: { digest: null },
            after: { digest: `sha256:${hex("after-adopt")}` },
            proof: { changes: [], summary: "No changes." },
            ...(status === "applied" ? { verify: { changes: [], summary: "No changes." } } : {}),
            source: { backend: "s3", location: o.stateKey, version_id: o.versionId, digest: `sha256:${hex("state")}` },
          },
        ],
      };
    }
    return {
      ...base,
      change: "retag",
      retags: teamB
        .filter((r) => !r.follows)
        .map((r) => ({ address: r.address, from: "shared", to: "team-b", from_estate: this.estate("shared"), to_estate: this.estate("team-b"), live_id: this.liveId(r), followers: RESOURCES.filter((x) => x.follows === r.address).map((x) => x.address) })),
      roots: ["shared", "team-b"].map((root) => ({
        root,
        backend: "live",
        before: { digest: null },
        after: { digest: `sha256:${hex(`after-split-${root}`)}` },
        proof: { changes: [], summary: "No changes." },
        ...(status === "applied" ? { verify: { changes: [], summary: "No changes." } } : {}),
      })),
    };
  }

  private demoJson(s: TourStep): Record<string, unknown> {
    const now = secs(new Date());
    return {
      intro: "Big Terraform setups are split into separate states, and a change across them is not one transaction.",
      name: "the shared root carve",
      tool: "terralith",
      repo: this.repo,
      index: 1,
      scenarios: 1,
      delivery: null,
      beat: s.beat,
      cycle: this.cycle,
      scenario: "terralith",
      title: "One shared root adopted, team B carved out, then changed",
      step: s.step,
      label: s.label,
      started_at: this.startedAt,
      next: s.next ? { action: s.next, from: now, at: null } : null,
      pull: s.step === "reset" ? null : this.pull,
      commit: this.commit,
      about: null,
    };
  }

  private write(s: TourStep): void {
    this.files.set("demo.json", this.demoJson(s));
    this.flush();
  }

  /** Every file as it stands, written atomically enough for a reader that polls. */
  private flush(): void {
    const put = (key: string, doc: unknown, text = `${JSON.stringify(doc, null, 1)}\n`) => {
      const f = join(this.dir, key);
      mkdirSync(dirname(f), { recursive: true });
      // A rename, so a poll never reads half a file.
      writeFileSync(`${f}.tmp`, text);
      renameSync(`${f}.tmp`, f);
    };
    for (const [k, v] of this.files) put(k, v);
    const newest = [...this.rows].reverse();
    put("index.json", { schema: "terragucci.report-index/v1", reports: newest.map((r) => ({ ...r, path: `${r.project}/${r.path}` })) });
    for (const project of [P, PT]) {
      const rows = newest.filter((r) => r.project === project);
      if (rows.length) put(`${project}/index.json`, { schema: "terragucci.report-index/v1", reports: rows });
    }
    put("estates.json", { schema: "terragucci.estates/v1", estates: [...this.estates.values()].sort((a, b) => (a.estate < b.estate ? -1 : 1)) });
    for (const m of this.migrations) {
      put(`${m.project}/migrations/${m.name}.json`, m.record);
      if (m.lines.length) put(`${m.project}/migrations/${m.name}/progress.jsonl`, null, m.lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    }
    put("runs/index.json", { schema: "demo.runs/v1", updated_at: this.now(), keep: 30, runs: [...this.runs].reverse() });
  }
}

/** The checkout behold serves beside the reports: demo-terralith's main after the cross beat, as files. */
export function writeCheckout(dir: string): void {
  const put = (p: string, text: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  };
  put("terragucci.yml", "forge: forgejo\nbinary: choudoufu\nreports:\n  bucket: s3://demo-reports\n  prefix: demo\n");
  const block = (r: Res) => `resource "${r.type}" "${r.address.split(".")[1]!.replace(/\[\d+\]$/, "")}" {\n}\n`;
  const seen = new Set<string>();
  for (const root of ["shared", "team-b"] as const) {
    const text = RESOURCES.filter((r) => r.root === root)
      .filter((r) => {
        const k = r.address.replace(/\[\d+\]$/, "");
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map(block)
      .join("\n");
    put(`${root}/main.tf`, `terraform {\n  live {\n    estate = "tl-${root}"\n  }\n}\n\n${text}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (k: string, d: string): string => {
    const at = args.indexOf(k);
    return at >= 0 && args[at + 1] ? args[at + 1]! : d;
  };
  const port = Number(opt("--port", "4714"));
  const stepMs = Number(opt("--step-ms", "6000"));
  const dir = opt("--dir", "") || mkdtempSync(join(tmpdir(), "behold-tour-"));
  const reports = join(dir, "reports");
  const checkout = join(dir, "demo-terralith");
  mkdirSync(reports, { recursive: true });
  writeCheckout(checkout);
  const cycle = new TourCycle(reports);
  await cycle.next();
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const serve = spawn(process.execPath, ["--import", "tsx", join(root, "src", "cli.ts"), "serve", checkout, "--terragucci", reports, "--terragucci-project", P, "--public", "--host", "127.0.0.1", "--port", String(port)], { stdio: "inherit", cwd: root });
  process.stdout.write(`behold tour preview: http://127.0.0.1:${port}/kiosk  (reports in ${reports}, a step every ${stepMs / 1000} s)\n`);
  const tick = async (): Promise<void> => {
    const s = await cycle.next();
    process.stdout.write(`cycle ${cycle.cycle}: ${s.beat ?? "-"} ${s.step}\n`);
    setTimeout(() => void tick(), stepMs);
  };
  setTimeout(() => void tick(), stepMs);
  const stop = () => {
    serve.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
