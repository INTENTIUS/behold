/**
 * The carve walkthrough's two local actions (#254, M1.5 of #230) — `chant carve
 * emit` and `chant carve bridge`, run inside a `behold demo carve` copy.
 *
 * THE WRITE BOUNDARY. This is behold's second write (src/layout.ts is the
 * first), and it is drawn tighter than that one:
 *
 *   * It exists ONLY inside a demo copy. `CarveDemo` is built by `behold demo
 *     carve` from the directory it just copied — never from a request, never
 *     from a query param. A plain `behold carve report.json` has no demo, and
 *     the two routes refuse; a project `serve` never registers them at all.
 *   * ONE directory is written: `<demo.out>` (`app/carveout` in the copy). Both
 *     chant runs are handed `--output <demo.out>`, and `carve bridge` is run
 *     WITHOUT `--apply-rewrites`, so the surviving Terraform is never edited —
 *     the rewritten `.tf` lands beside the runbook as a proposal.
 *   * The only value off the wire is `select`, and it must be an address the
 *     report already ranks (`selectFromReport`). Nothing string-shaped from a
 *     request reaches a path or a shell — the args are an argv array, and the
 *     one request-derived element is drawn from a closed set.
 *   * Everything read back is read from inside `<demo.out>`, capped, and
 *     truncated rather than streamed whole.
 *
 * The invariant is untouched: no cloud write, no Terraform mutation, no edit to
 * anyone's chant source. The demo copy is the user's own scratch directory, and
 * a carve emits into it exactly the way the CLI would.
 *
 * Emit shows `chant lint`, never `chant build` — chant#1637's fold is applied
 * now (chant 0.44.7, chant PR #1640): the emitted bucket carries its folded
 * versioning/public-access-block sub-resources as native props, so `build`
 * fails only WAW042, a TLS-deny bucket policy the source Terraform genuinely
 * never declared. That is real drift the estate inherited, not a carve gap —
 * `lint` stays the gate shown because `build` still fails, just for a reason
 * worth reading rather than a tooling shortfall. example-carve/README.md
 * carries the full statement of it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runChantRaw, stripAnsi } from "./chant.ts";
import { unwritableReason } from "./layout.ts";
import type { CarveReport } from "./carve-lens.ts";

/**
 * A booted `behold demo carve` copy — the only context in which the carve
 * actions exist. Every path is absolute and inside `root`; `runDemo`
 * (src/cli.ts) is the only thing that builds one.
 */
export interface CarveDemo {
  /** The demo copy's root. The containment check's ceiling. */
  root: string;
  /** The Terraform estate to carve from (`legacy-tf/`). */
  from: string;
  /** The synthetic `.tfstate` — what makes emit work offline. */
  state?: string;
  /** The chant project whose own chant + lexicon the runs use (`app/`). */
  project: string;
  /** Where emitted source, proposals and the runbook land (`app/carveout/`). */
  out: string;
  /** Set when the boot's own `carve advise` failed and the committed report is
   * being served instead — surfaced in the UI rather than swallowed. */
  degraded?: string;
}

/** Caps on what comes back through the wire. A carve emits one source file and
 * a handful of proposals; anything past these is a mistake, and the answer is a
 * truncated read, never an unbounded one. */
export const MAX_ARTIFACT_BYTES = 64 * 1024;
export const MAX_ARTIFACTS = 24;
export const MAX_OUTPUT_BYTES = 32 * 1024;

/** One file the run wrote, as the client renders it. */
export interface CarveArtifact {
  /** Path relative to the demo copy's root — never an absolute host path. */
  path: string;
  /** File extension without the dot (`ts`, `tf`, `md`, `patch`, `json`). */
  kind: string;
  bytes: number;
  text: string;
  /** True when `text` is only the first {@link MAX_ARTIFACT_BYTES} of the file. */
  truncated: boolean;
}

/** A refusal, in #193's structured shape — what the stepper renders in place of
 * the step's result. */
export interface CarveActionRefusal {
  error: string;
  code: "carve-action" | "carve-select" | "read-only";
  remedy: string;
}

export interface CarveEmitResult {
  ok: true;
  select: string;
  /** The argv actually run, for the UI to show verbatim. */
  command: string;
  output: string;
  artifacts: CarveArtifact[];
  /** chant's boundary report for this carve — the edges the cut severs, named.
   * Present whether or not `carve advise` published edge lists (chant#1636):
   * `carve emit --report` writes them per-carve regardless. */
  boundary: unknown;
  lint: { ok: boolean; code: number; command: string; output: string };
  /** chant#1637 — why the gate is lint and not build. */
  buildCaveat: string;
}

export interface CarveBridgeResult {
  ok: true;
  select: string;
  command: string;
  output: string;
  /** The handoff runbook, split into its own field: step 5 is built from it. */
  runbook: CarveArtifact | null;
  /** The proposed survivor edits — data sources, rewritten `.tf`, the patch. */
  proposals: CarveArtifact[];
}

export type CarveActionResult<T> = T | { ok: false; refusal: CarveActionRefusal };

const refuse = (code: CarveActionRefusal["code"], error: string, remedy: string): { ok: false; refusal: CarveActionRefusal } => ({
  ok: false,
  refusal: { error, code, remedy },
});

/** chant#1637's fold, applied at chant 0.44.7 (chant PR #1640) — stated once. */
export const BUILD_CAVEAT =
  "The gate shown is `chant lint`, not `chant build`. chant#1637's fold is applied now: the bucket's " +
  "versioning and public-access-block sub-resources come out as native props, not just folded-in mentions. " +
  "`chant build` still fails, but on one rule only — WAW042, a TLS-deny bucket policy the source Terraform " +
  "never declared. That's real drift the estate inherited, not a gap in the carve. " +
  "example-carve/README.md, \"Why build still fails\", has the full statement.";

/** Is `p` inside `root`? Lexical containment on resolved paths — both come from
 * this process (the demo copy and a path built from it), so there is no symlink
 * game to play here; this is the belt to `CarveDemo`'s braces. */
export function insideDemo(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The address a request asked to carve, or null.
 *
 * The check is membership, not syntax: `select` must be an address the report
 * in hand already ranks. That is the tightest possible validation — the value
 * that reaches the spawn's argv is drawn from a closed set the server read off
 * disk, so no request can name anything chant wasn't already going to talk
 * about. A syntactic regex would be a weaker claim about the same argument.
 */
export function selectFromReport(report: CarveReport | undefined, raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 512) return null;
  return (report?.resources ?? []).some((r) => r.address === raw) ? raw : null;
}

/** Why this demo can't take a carve run, or null when it can. */
export function carveWriteBlock(demo: CarveDemo | undefined): string | null {
  if (!demo) {
    return (
      "this server isn't running a carve demo — the carve actions only exist inside a `behold demo carve` copy"
    );
  }
  if (!existsSync(demo.from)) return `the demo copy has no Terraform estate at ${demo.from}`;
  if (!insideDemo(demo.root, demo.out)) return "the carve output directory is outside the demo copy";
  return unwritableReason(demo.root);
}

/** Every file under `dir` (one level of nesting is enough for a carveout), as
 * artifacts relative to the demo root. Capped, sorted, and read defensively —
 * an unreadable file is skipped, never fatal. */
export function readArtifacts(demo: CarveDemo, dir: string, filter: (rel: string) => boolean): CarveArtifact[] {
  const out: CarveArtifact[] = [];
  const walk = (d: string, depth: number): void => {
    if (out.length >= MAX_ARTIFACTS || depth > 2) return;
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= MAX_ARTIFACTS) return;
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const rel = relative(demo.root, full).split(sep).join("/");
      if (!filter(rel)) continue;
      let text = "";
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const truncated = text.length > MAX_ARTIFACT_BYTES;
      out.push({
        path: rel,
        kind: (name.split(".").pop() ?? "").toLowerCase(),
        bytes: st.size,
        text: truncated ? text.slice(0, MAX_ARTIFACT_BYTES) : text,
        truncated,
      });
    }
  };
  walk(dir, 0);
  return out;
}

/** chant's own slug for a carve target (`aws_s3_bucket.assets` →
 * `aws_s3_bucket-assets`), which is how its artifacts are named. Mirrors
 * carve-bridge.ts's `select.replace(/[^A-Za-z0-9_]+/g, "-")`. */
export function carveSlug(select: string): string {
  return select.replace(/[^A-Za-z0-9_]+/g, "-");
}

const clip = (s: string): string => (s.length > MAX_OUTPUT_BYTES ? s.slice(0, MAX_OUTPUT_BYTES) + "\n… (truncated)" : s);

/** One argv element with the demo copy's absolute prefix taken off, so the
 * echoed command line is the one a viewer could retype. */
export function shortenIn(arg: string, root: string): string {
  return arg.startsWith(root + sep) ? arg.slice(root.length + 1) : arg === root ? "." : arg;
}

/**
 * stdout + stderr as one block, the way the CLI prints it — minus chant's ANSI
 * colours (the spawn's stdout isn't a TTY but chant colours it anyway; see
 * chant.ts's note on `isTTY`), and minus the demo copy's absolute prefix.
 *
 * The path rewrite is presentation, not redaction: chant echoes the absolute
 * `--from`/`--output` it was handed, and a card that reads
 * `/private/tmp/.../demorun/app/carveout/src/assets.ts` teaches a viewer
 * nothing except how long the operator's tmpdir is. `app/carveout/src/assets.ts`
 * is the same fact at the scale the picture is about.
 */
function merge(r: { stdout: string; stderr: string }, root: string): string {
  const joined = stripAnsi([r.stdout, r.stderr].filter((s) => s.trim()).join("\n").trim());
  return clip(joined.split(root + sep).join("").split(root).join("."));
}

/**
 * Step 3 — `chant carve emit --state --select <addr> --output <out>`, then
 * `chant lint` on what it wrote.
 *
 * chant writes `--report` before it creates `--output`, so the directory is
 * made here first; without that the run exits having written nothing but an
 * ENOENT (verified against chant 0.44.4).
 */
export async function runCarveEmit(demo: CarveDemo, select: string): Promise<CarveActionResult<CarveEmitResult>> {
  const block = carveWriteBlock(demo);
  if (block) return refuse("read-only", block, "Start the walkthrough with `behold demo carve`.");

  mkdirSync(demo.out, { recursive: true });
  const reportFile = join(demo.out, `${carveSlug(select)}-boundary.json`);
  const args = [
    "carve",
    "emit",
    "--from",
    demo.from,
    ...(demo.state ? ["--state", demo.state] : []),
    "--select",
    select,
    "--output",
    demo.out,
    "--report",
    reportFile,
  ];
  const run = await runChantRaw(args, demo.project).catch((err: unknown) => ({
    code: 127,
    stdout: "",
    stderr: err instanceof Error ? err.message : String(err),
  }));
  const output = merge(run, demo.root);
  if (run.code !== 0) {
    return refuse(
      "carve-action",
      `chant carve emit exited ${run.code}: ${output || "(no output)"}`,
      "The offline emit needs `@cdktf/hcl2json` in the demo copy and the demo's own chant install — " +
        "`npm install` in the copy's `app/` and re-run `behold demo carve`.",
    );
  }

  let boundary: unknown = null;
  try {
    boundary = JSON.parse(readFileSync(reportFile, "utf8"));
  } catch {
    /* the run said ok; a missing report is a chant that stopped writing one */
  }

  // Lint from the chant project, by a path relative to it: the emitted source
  // imports the AWS lexicon, and Node resolves that from where the FILE sits.
  // `app/carveout/src` resolves through `app/node_modules`; a carveout beside
  // `app/` would not resolve at all.
  const lintPath = relative(demo.project, join(demo.out, "src")).split(sep).join("/");
  const lintArgs = ["lint", lintPath];
  const lint = await runChantRaw(lintArgs, demo.project).catch((err: unknown) => ({
    code: 127,
    stdout: "",
    stderr: err instanceof Error ? err.message : String(err),
  }));

  return {
    ok: true,
    select,
    command: `chant ${args.map((a) => shortenIn(a, demo.root)).join(" ")}`,
    output,
    // Emitted source first, scaffolding after: `src/assets.ts` is the thing the
    // step is about, and a package.json sorting above it buries the answer.
    artifacts: readArtifacts(demo, demo.out, (rel) => /\.(ts|json)$/.test(rel) && !rel.endsWith("tsconfig.json")).sort(
      (a, b) => Number(!/\/src\//.test(a.path)) - Number(!/\/src\//.test(b.path)),
    ),
    boundary,
    lint: { ok: lint.code === 0, code: lint.code, command: `chant ${lintArgs.join(" ")}`, output: merge(lint, demo.root) },
    buildCaveat: BUILD_CAVEAT,
  };
}

/**
 * Step 4 — `chant carve bridge --from <tf> --output <out>`, deliberately
 * WITHOUT `--apply-rewrites`.
 *
 * `--select` is passed explicitly even though the manifest emit left in `out`
 * would supply it: the step should mean the same thing whether or not emit ran
 * in this session, and a bridge for a resource the user did not pick would be a
 * surprising thing to compute.
 */
export async function runCarveBridge(demo: CarveDemo, select: string): Promise<CarveActionResult<CarveBridgeResult>> {
  const block = carveWriteBlock(demo);
  if (block) return refuse("read-only", block, "Start the walkthrough with `behold demo carve`.");

  mkdirSync(demo.out, { recursive: true });
  const args = [
    "carve",
    "bridge",
    "--from",
    demo.from,
    ...(demo.state ? ["--state", demo.state] : []),
    "--select",
    select,
    "--output",
    demo.out,
  ];
  const run = await runChantRaw(args, demo.project).catch((err: unknown) => ({
    code: 127,
    stdout: "",
    stderr: err instanceof Error ? err.message : String(err),
  }));
  const output = merge(run, demo.root);
  if (run.code !== 0) {
    return refuse(
      "carve-action",
      `chant carve bridge exited ${run.code}: ${output || "(no output)"}`,
      "Run the Emit step first — bridge reads the carve manifest emit leaves in the output directory.",
    );
  }

  const slug = carveSlug(select);
  const all = readArtifacts(demo, demo.out, (rel) => /\.(tf|md|patch)$/.test(rel));
  return {
    ok: true,
    select,
    command: `chant ${args.map((a) => shortenIn(a, demo.root)).join(" ")}`,
    output,
    runbook: all.find((a) => a.path.endsWith(`${slug}-runbook.md`)) ?? null,
    proposals: all.filter((a) => !a.path.endsWith(`${slug}-runbook.md`)),
  };
}
