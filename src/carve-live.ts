/**
 * The Floci `--live` tier of the carve walkthrough (#254, second comment).
 *
 * The offline tier proves the mechanics against a synthetic tfstate; this tier
 * turns "the resource stays live through the carve" from a caption into
 * something the viewer can poke: a scratch Floci in Docker, the demo copy's
 * Terraform REALLY applied into it, a real `terraform plan` at handoff showing
 * no destroy, and the observe beat after Emit — chant reading the carved
 * resource live from the carveout while Terraform still owns it (chant#1647's
 * identity read path, chant ≥ 0.44.12; runCarveObserve in carve-actions.ts).
 *
 * Scratch discipline (src/scratch.ts, asserted in scratch.test.ts): our own
 * container name, refuse-if-exists, teardown on exit — never an existing
 * `floci*` or `chant-floci*`, never their :4566. The port moves too, so a
 * shared Floci on the conventional port is never spoken to by accident: the
 * committed override template names :4566 and `armOverride` rewrites it.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assertScratch } from "./scratch.js";

export interface CarveLiveInfo {
  container: string;
  port: number;
  endpoint: string;
  /** The addresses `terraform apply -target` created in the scratch Floci. */
  applied: string[];
}

export const LIVE_CONTAINER = "behold-carve-floci";
export const LIVE_PORT = 4602;
/** chant's own pinned emulator image (lexicons/aws floci activity) — pinned,
 * not `:latest`, for the same reason chant pins it. */
export const LIVE_IMAGE = "floci/floci:1.5.34";

/** The resources the live tier applies — the starred pair plus the bucket's
 * two fold-in sub-resources. Deliberately NOT the whole estate: Floci's
 * community edition emulates S3 and CloudWatch Logs; the VPC, lambda and CDN
 * are the grey band's scenery and stay paper (the override template says the
 * same). `-target` pulls dependencies in on its own. */
export const LIVE_TARGETS = [
  "aws_s3_bucket.assets",
  "aws_s3_bucket_versioning.assets",
  "aws_s3_bucket_public_access_block.assets",
  "aws_cloudwatch_log_group.worker",
];

/** Arm the committed override template for a scratch port: every
 * `localhost:4566` endpoint becomes `localhost:<port>`. Pure — the caller
 * writes the result as `floci_override.tf` (terraform's `*_override.tf` merge
 * replaces the provider block without editing `versions.tf`). */
export function armOverride(disabledText: string, port: number): string {
  return disabledText.replaceAll("localhost:4566", `localhost:${port}`);
}

/** The one line of a `terraform plan -no-color` that states the verdict, and
 * the claim the whole tier exists to film: nothing gets destroyed. Exit code
 * (with `-detailed-exitcode`): 0 = no changes, 2 = changes present. */
export function parsePlanOutput(stdout: string, exitCode: number): { planLine: string; changes: boolean; noDestroy: boolean } {
  const planLine =
    stdout
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("Plan:") || l.includes("No changes.")) ?? `terraform plan exited ${exitCode}`;
  const destroyMatch = planLine.match(/(\d+) to destroy/);
  return {
    planLine: planLine.trim(),
    changes: exitCode === 2,
    noDestroy: !destroyMatch || destroyMatch[1] === "0",
  };
}

type Step = (cmd: string, args: string[], cwd: string) => Promise<number>;

/** A child's stdout+stderr as one string (interleaved, the way a terminal
 * shows it), -1 on spawn error. */
function capture(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd, shell: process.platform === "win32" });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => res({ code: -1, stdout: out }));
    child.on("close", (code) => res({ code: code ?? 1, stdout: out }));
  });
}

/** Boot the scratch Floci: refuse if the name is taken (this tier only ever
 * deletes a container it created), run detached with `--rm`, wait for the
 * health endpoint to list cloudformation. Returns an error string instead of
 * throwing — the caller turns it into a refusal with a remedy. */
export async function bootScratchFloci(): Promise<string | undefined> {
  assertScratch(LIVE_CONTAINER, LIVE_PORT);
  const ps = await capture("docker", ["ps", "-a", "--format", "{{.Names}}"], process.cwd());
  if (ps.code !== 0) return "docker isn't answering — is the daemon up?";
  if (ps.stdout.split("\n").includes(LIVE_CONTAINER)) {
    return `container ${LIVE_CONTAINER} already exists — a previous run didn't tear down. \`docker rm -f ${LIVE_CONTAINER}\` and re-run.`;
  }
  const run = await capture(
    "docker",
    ["run", "-d", "--rm", "-p", `${LIVE_PORT}:4566`, "--name", LIVE_CONTAINER, LIVE_IMAGE],
    process.cwd(),
  );
  if (run.code !== 0) return `docker run ${LIVE_IMAGE} failed (${run.code})`;
  for (let i = 0; i < 30; i++) {
    try {
      const health = await fetch(`http://localhost:${LIVE_PORT}/_localstack/health`);
      if (health.ok && (await health.text()).includes("cloudformation")) return undefined;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await teardownScratchFloci();
  return `Floci never reported healthy on :${LIVE_PORT} after 30s`;
}

/** Best-effort removal of OUR container only. Safe to call twice. */
export async function teardownScratchFloci(): Promise<void> {
  await capture("docker", ["rm", "-f", LIVE_CONTAINER], process.cwd()).catch(() => undefined);
}

/**
 * The live boot: arm the override in the copy's Terraform, drop the synthetic
 * tfstate, `terraform init` + targeted apply into the scratch Floci. After
 * this the tfstate beside the `.tf` files is real — written by terraform —
 * and the advisor run that follows reads it. Returns an error string on the
 * first failed step; the caller tears the container down and refuses.
 */
export async function applyIntoFloci(fromDir: string, step: Step): Promise<string | undefined> {
  const template = join(fromDir, "floci-override.tf.disabled");
  if (!existsSync(template)) return `no floci-override.tf.disabled in ${fromDir} — this estate wasn't authored for the live tier`;
  writeFileSync(join(fromDir, "floci_override.tf"), armOverride(readFileSync(template, "utf8"), LIVE_PORT));

  const init = await step("terraform", ["init", "-input=false", "-no-color"], fromDir);
  if (init !== 0) return `terraform init exited ${init} (provider downloads need network)`;
  const apply = await step(
    "terraform",
    ["apply", "-input=false", "-auto-approve", "-no-color", ...LIVE_TARGETS.map((t) => `-target=${t}`)],
    fromDir,
  );
  if (apply !== 0) return `terraform apply exited ${apply}`;
  return undefined;
}

/** `terraform plan` in the demo copy's Terraform, for the handoff beat: after
 * `terraform state rm` the plan must show the carved resource is simply gone
 * from Terraform's world — not destroyed. Read-only against the estate AND
 * the emulator. `-detailed-exitcode` makes the contract explicit: 0 = no-op,
 * 2 = changes; anything else is a FAILURE (a dead emulator, a broken config)
 * and comes back as `error`, never dressed up as a verdict — a plan that
 * couldn't refresh has no standing to say "nothing gets destroyed". */
export async function runLivePlan(
  fromDir: string,
): Promise<{ planLine: string; changes: boolean; noDestroy: boolean; exitCode: number } | { error: string; exitCode: number }> {
  const r = await capture("terraform", ["plan", "-input=false", "-no-color", "-detailed-exitcode", ...LIVE_TARGETS.map((t) => `-target=${t}`)], fromDir);
  if (r.code !== 0 && r.code !== 2) {
    const tail = r.stdout.trim().split("\n").slice(-8).join("\n");
    return { error: `terraform plan failed (exit ${r.code}):\n${tail}`, exitCode: r.code };
  }
  return { ...parsePlanOutput(r.stdout, r.code), exitCode: r.code };
}
