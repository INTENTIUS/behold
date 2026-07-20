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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";

export type SubstrateStatus = "up" | "down" | "on-demand" | "blocked" | "unknown";

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

/** The lexicons a project declares (from `chant.config.ts` `lexicons: [...]`) —
 * best-effort text scan, so we only offer substrates the project actually uses
 * (an aws project shouldn't show a red "k3d down"). Empty when unreadable. */
function projectLexicons(projectDir: string): string[] {
  try {
    const src = readFileSync(join(projectDir, "chant.config.ts"), "utf-8");
    const m = src.match(/lexicons\s*:\s*\[([^\]]*)\]/);
    if (!m) return [];
    return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  } catch {
    return [];
  }
}

/**
 * Detect the substrates a locally-served project might need. Ordered
 * Floci → k3d → GitLab CI → Forgejo. Cheap probes only (a few `docker`/`k3d`
 * calls); safe to poll.
 */
export async function detectSubstrates(projectDir: string, preview = false): Promise<Substrate[]> {
  const subs: Substrate[] = [];
  const lexicons = projectLexicons(projectDir);
  const docker = await dockerAvailable();

  // Docker — the ROOT of the local emulator/runner substrates. When it's down
  // that's the single actionable thing (start Docker Desktop), so the
  // docker-dependent substrates below read "blocked" (muted), not four alarming
  // reds. On macOS behold can start Docker Desktop for you (`open -a Docker`).
  subs.push({
    name: "docker",
    label: "Docker",
    status: docker ? "up" : "down",
    detail: docker ? "daemon running" : "daemon not running",
    bringUp: docker || platform() !== "darwin" ? undefined : { label: "open -a Docker", cmd: "open", args: ["-a", "Docker"] },
  });

  // A docker-dependent substrate reads "blocked" (waiting on Docker), not "down",
  // when the daemon is off — the fix is Docker, not this thing.
  const dep = (up: boolean, upDetail: string, offDetail: string): { status: SubstrateStatus; detail: string } =>
    !docker ? { status: "blocked", detail: "waiting on Docker" } : { status: up ? "up" : (offDetail === "on-demand (pipeline run)" ? "on-demand" : "down"), detail: up ? upDetail : offDetail };

  // Floci — only for an aws-lexicon project (it emulates AWS managed services).
  if (lexicons.includes("aws")) {
    const floci = docker ? await dockerRunning("^floci$") : [];
    const d = dep(floci.length > 0, "container up on :4566", "not running");
    subs.push({
      name: "floci",
      label: "Floci",
      ...d,
      bringUp: docker && !floci.length ? scriptBringUp(projectDir, "scripts/local/local-up.sh", "local-up") : undefined,
    });
  }

  // Preview (v0.1.0) stops here: the Loom demo only needs Docker + Floci, so the
  // CI/forge and k3d substrates are out of scope.
  if (preview) return subs;

  // GitLab CI / Forgejo — only when the project actually targets that forge
  // (ships its generated CI). On-demand pipeline runs (gitlab-ci-local / forgejo
  // runtime-e2e), so absence is "on-demand", not "down".
  const forges: Array<[string, string, string, string]> = [
    ["gitlab-ci", "GitLab CI", ".gitlab", "test/gitlab-runtime-e2e.sh"],
    ["forgejo", "Forgejo", ".forgejo", "test/forgejo-runtime-e2e.sh"],
  ];
  for (const [name, label, marker, script] of forges) {
    if (!existsSync(join(projectDir, marker))) continue; // project doesn't target this forge
    const c = docker ? await dockerRunning(name) : [];
    const d = dep(c.length > 0, "container up", "on-demand (pipeline run)");
    subs.push({
      name,
      label,
      ...d,
      bringUp: docker ? scriptBringUp(projectDir, script, `run ${label} pipeline`) : undefined,
    });
  }

  // k3d — only for a k8s-lexicon project. "unknown" if k3d isn't installed.
  if (lexicons.includes("k8s")) {
    const k3d = await probe("k3d", ["cluster", "list", "--no-headers"]);
    const clusters = k3d.code === 0 ? k3d.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    subs.push({
      name: "k3d",
      label: "k3d",
      status: k3d.code === 127 ? "unknown" : clusters.length ? "up" : "down",
      detail: k3d.code === 127 ? "k3d not installed" : clusters.length ? `${clusters.length} cluster(s)` : "no clusters",
    });
  }

  return subs;
}
