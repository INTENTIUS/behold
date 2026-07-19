/**
 * Substrate readiness (M5): behold has always assumed the local substrate is
 * already up (Floci running + provisioned) and just observed/applied against it.
 * This surfaces the layer above — is each substrate the project needs actually
 * running? — and offers a one-click bring-up (the scripts already exist:
 * loomster's `scripts/local/local-up.sh`, `test/gitlab-runtime-e2e.sh`, …).
 *
 * Detection is best-effort and read-only: `docker ps` for the persistent
 * emulators (Floci), `k3d cluster list` for a local k8s cluster. GitLab CI /
 * Forgejo are on-demand pipeline runs (gitlab-ci-local / forgejo runtime-e2e),
 * not persistent daemons — reported as `on-demand`, not a false "down". A
 * bring-up is only offered when the project actually ships the script for it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type SubstrateStatus = "up" | "down" | "on-demand" | "unknown";

export interface Substrate {
  /** Stable id (route key). */
  name: string;
  /** Display label. */
  label: string;
  status: SubstrateStatus;
  /** One-line human detail behind the status. */
  detail: string;
  /** The bring-up command, when the project ships a script for it. Absent when
   * there's nothing to run (already up, or no script in this project). */
  bringUp?: { label: string; cmd: string; args: string[] };
}

/** Run a probe command, capturing combined output + exit code. A missing binary
 * (ENOENT) resolves to code 127 rather than throwing — "not installed" is data. */
function probe(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ code: 127, out: "" });
      return;
    }
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("error", () => resolve({ code: 127, out }));
    proc.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

/** Is the Docker daemon reachable? Every container-backed substrate (and their
 * bring-up scripts) needs it, so when it's down we say so once rather than
 * offering futile per-substrate bring-ups. */
async function dockerAvailable(): Promise<boolean> {
  const { code } = await probe("docker", ["info", "--format", "{{.ServerVersion}}"]);
  return code === 0;
}

/** Names of running docker containers matching a `docker ps --filter name=` value. */
async function dockerRunning(nameFilter: string): Promise<string[]> {
  const { code, out } = await probe("docker", ["ps", "--filter", `name=${nameFilter}`, "--format", "{{.Names}}"]);
  if (code !== 0) return [];
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** A bring-up script this project ships, as a `bash <path>` command — or undefined. */
function scriptBringUp(projectDir: string, relPath: string, label: string): Substrate["bringUp"] | undefined {
  return existsSync(join(projectDir, relPath)) ? { label, cmd: "bash", args: [relPath] } : undefined;
}

/**
 * Detect the substrates a locally-served project might need. Ordered
 * Floci → k3d → GitLab CI → Forgejo. Cheap probes only (a few `docker`/`k3d`
 * calls); safe to poll.
 */
export async function detectSubstrates(projectDir: string): Promise<Substrate[]> {
  const subs: Substrate[] = [];

  // Docker underpins Floci / GitLab CI / Forgejo and their bring-up scripts — if
  // its daemon is down, surface that as the actionable root cause (behold can't
  // start Docker Desktop for you) rather than a misleading per-substrate "down".
  const docker = await dockerAvailable();

  // Floci — the persistent AWS-managed-services emulator loomster's local-up
  // brings up (`docker run --name floci … :4566`). The one true "is the local
  // cloud up?" signal for an aws-lexicon project.
  const floci = docker ? await dockerRunning("^floci$") : [];
  subs.push({
    name: "floci",
    label: "Floci",
    status: floci.length ? "up" : "down",
    detail: !docker ? "Docker daemon not running — start Docker Desktop first" : floci.length ? "container up on :4566" : "not running",
    // Only offer the bring-up when Docker can actually run it.
    bringUp: docker && !floci.length ? scriptBringUp(projectDir, "scripts/local/local-up.sh", "local-up") : undefined,
  });

  // k3d — a local Kubernetes cluster (k8s-lexicon projects). "unknown" when k3d
  // isn't installed, so a non-k8s project doesn't show a scary red "down".
  const k3d = await probe("k3d", ["cluster", "list", "--no-headers"]);
  const clusters = k3d.code === 0 ? k3d.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  subs.push({
    name: "k3d",
    label: "k3d",
    status: k3d.code === 127 ? "unknown" : clusters.length ? "up" : "down",
    detail: k3d.code === 127 ? "k3d not installed" : clusters.length ? `${clusters.length} cluster(s)` : "no clusters",
  });

  // GitLab CI / Forgejo — loomster runs these on-demand (gitlab-ci-local /
  // forgejo runtime-e2e spin up an ephemeral pipeline against their own Floci,
  // then tear down). So absence isn't "down" — it's "on-demand". Bring-up runs
  // the runtime-e2e (a live pipeline), when the project ships that script.
  const forges: Array<[string, string, string]> = [
    ["gitlab-ci", "GitLab CI", "test/gitlab-runtime-e2e.sh"],
    ["forgejo", "Forgejo", "test/forgejo-runtime-e2e.sh"],
  ];
  for (const [name, label, script] of forges) {
    const c = docker ? await dockerRunning(name) : [];
    subs.push({
      name,
      label,
      status: !docker ? "down" : c.length ? "up" : "on-demand",
      detail: !docker ? "Docker daemon not running" : c.length ? "container up" : "on-demand (pipeline run)",
      bringUp: docker ? scriptBringUp(projectDir, script, `run ${label} pipeline`) : undefined,
    });
  }

  return subs;
}
