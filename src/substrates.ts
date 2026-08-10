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
import { ambientContext } from "./k8s-target.ts";

export type SubstrateStatus = "up" | "down" | "on-demand" | "blocked" | "unknown";

/** The one detail every docker-dependent substrate reports when the daemon
 * probe already failed — a single root-cause message instead of each row's
 * own confused reading of a socket it can't reach (behold#280: k3d said "down
 * — no clusters" when the real cause was Docker Desktop not running). */
const DOCKER_DOWN_DETAIL = "docker is down";

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

/** The raw probe, injectable so a docker-down (or k3d-down) fixture is
 * testable without a real Docker daemon or `k3d` binary on the machine
 * running the tests (behold#280). Default is the real spawn-based one above —
 * every probe in this module (docker, k3d, gh, helm, forge containers) goes
 * through whichever one the caller passed in. */
export interface SubstrateProbes {
  probe?: (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;
}

/** Is the Docker daemon reachable? Every container-backed substrate (and their
 * bring-up scripts) needs it, so when it's down we say so once rather than
 * offering futile per-substrate bring-ups. */
async function dockerAvailable(run: typeof probe): Promise<boolean> {
  const { code } = await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  return code === 0;
}

/** Names of running docker containers matching a `docker ps --filter name=` value. */
async function dockerRunning(run: typeof probe, nameFilter: string): Promise<string[]> {
  const { code, out } = await run("docker", ["ps", "--filter", `name=${nameFilter}`, "--format", "{{.Names}}"]);
  if (code !== 0) return [];
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** A bring-up script this project ships, as a `bash <path>` command — or undefined. */
function scriptBringUp(projectDir: string, relPath: string, label: string): Substrate["bringUp"] | undefined {
  return existsSync(join(projectDir, relPath)) ? { label, cmd: "bash", args: [relPath] } : undefined;
}

/** The lexicons a project declares (from `chant.config.ts` `lexicons: [...]`) —
 * best-effort text scan, so we only offer substrates the project actually uses
 * (an aws project shouldn't show a red "k3d down"). Empty when unreadable.
 * Exported for server.ts's target-lens resolution (#74): synchronous and cheap,
 * where `detectProject` is neither. */
export function projectLexicons(projectDir: string): string[] {
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
export async function detectSubstrates(
  projectDir: string,
  preview = false,
  boundContext?: string,
  probes: SubstrateProbes = {},
): Promise<Substrate[]> {
  const run = probes.probe ?? probe;
  const subs: Substrate[] = [];
  const lexicons = projectLexicons(projectDir);
  const docker = await dockerAvailable(run);

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

  // A docker-dependent substrate reads "blocked" (waiting on Docker), not "down"
  // (or its own confused reading of a socket it can't reach — behold#280), when
  // the daemon is off. One root cause, one object — DOCKER_BLOCKED, below — is
  // what every docker-dependent row (Floci, the emulators, the forge runners,
  // k3d) reports instead of probing further, with no bring-up of its own: the
  // fix is Docker, not this thing.
  const DOCKER_BLOCKED: { status: SubstrateStatus; detail: string } = { status: "blocked", detail: DOCKER_DOWN_DETAIL };
  const dep = (up: boolean, upDetail: string, offDetail: string): { status: SubstrateStatus; detail: string } =>
    !docker ? DOCKER_BLOCKED : { status: up ? "up" : (offDetail === "on-demand (pipeline run)" ? "on-demand" : "down"), detail: up ? upDetail : offDetail };

  // Floci — only for an aws-lexicon project (it emulates AWS managed services).
  // Two container-name conventions exist: the estates' own local-up scripts run
  // it as `floci` (kubemicrovm-ops names it that deliberately — its comment
  // cites this very probe), while `chant emulator up` names its container
  // `chant-floci` (src/emulator.ts). Probing only the first read the second as
  // down while it was serving — and offered to bring up what was already up.
  if (lexicons.includes("aws")) {
    const floci = docker ? await dockerRunning(run, "^floci$|^chant-floci$") : [];
    const d = dep(floci.length > 0, "container up on :4566", "not running");
    subs.push({
      name: "floci",
      label: "Floci",
      ...d,
      bringUp: docker && !floci.length ? scriptBringUp(projectDir, "scripts/local/local-up.sh", "local-up") : undefined,
    });
  }

  // floci-az / floci-gcp — the Azure and GCP emulators (behold#99). Same shape
  // as Floci above: docker-dependent, one container, a fixed port. They were
  // missing entirely, which is why an azure or gcp project saw no substrate at
  // all and the target lens had nothing to resolve against.
  const emulators: Array<[string, string, string, string, number]> = [
    ["azure", "floci-az", "floci-az", "^chant-floci-az$", 4577],
    ["gcp", "floci-gcp", "floci-gcp", "^chant-floci-gcp$", 4588],
  ];
  for (const [lexicon, name, label, pattern, port] of emulators) {
    if (!lexicons.includes(lexicon)) continue;
    const running = docker ? await dockerRunning(run, pattern) : [];
    subs.push({
      name,
      label,
      ...dep(running.length > 0, `container up on :${port}`, "not running"),
      bringUp: docker && !running.length ? scriptBringUp(projectDir, "scripts/local/local-up.sh", "local-up") : undefined,
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
    const c = docker ? await dockerRunning(run, name) : [];
    const d = dep(c.length > 0, "container up", "on-demand (pipeline run)");
    subs.push({
      name,
      label,
      ...d,
      bringUp: docker ? scriptBringUp(projectDir, script, `run ${label} pipeline`) : undefined,
    });
  }

  // k3d — only for a k8s-lexicon project. k3d rides the docker socket (its CLI
  // itself reports "no clusters" when it can't reach docker at all — the two
  // failures look identical from the outside), so a docker-down probe here
  // reads "blocked" via `dep` like Floci/the emulators/the forges above,
  // rather than running `k3d cluster list` and reporting whatever confused
  // thing it says back (behold#280). "unknown" (k3d not installed) is only
  // knowable once Docker is confirmed up and the CLI actually runs.
  // Bring-up (#88, the k3d turnkey demo): the same generic script convention
  // as Floci's above (scripts/local/local-up.sh) — offered only when Docker is
  // up, k3d is actually installed, and the project ships the script.
  if (lexicons.includes("k8s")) {
    if (!docker) {
      subs.push({ name: "k3d", label: "k3d", ...DOCKER_BLOCKED });
    } else {
      const k3d = await run("k3d", ["cluster", "list", "--no-headers"]);
      const clusters = k3d.code === 0 ? k3d.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
      subs.push({
        name: "k3d",
        label: "k3d",
        status: k3d.code === 127 ? "unknown" : clusters.length ? "up" : "down",
        detail: k3d.code === 127 ? "k3d not installed" : clusters.length ? `${clusters.length} cluster(s)` : "no clusters",
        bringUp:
          k3d.code !== 127 && !clusters.length
            ? scriptBringUp(projectDir, "scripts/local/local-up.sh", "local-up")
            : undefined,
      });
    }
  }

  // Fly (#74) — a fly-lexicon project has had a target var (`FLY_FLAPS_BASE_URL`,
  // src/targets.ts) since #99 but no pill, so the strip showed a target with no
  // substrate behind it. Not a daemon behold can boot: the var set means the
  // reads/applies aim at a local Flaps emulator someone runs; unset means the
  // real Fly API. Read-only either way.
  if (lexicons.includes("fly")) {
    const endpoint = process.env.FLY_FLAPS_BASE_URL;
    subs.push({
      name: "fly",
      label: "Fly",
      status: "on-demand",
      detail: endpoint ? `targeting ${endpoint}` : "real Fly (FLY_FLAPS_BASE_URL unset)",
    });
  }

  // GitHub Actions (#74) — the forge table above covers gitlab/forgejo because
  // both have a LOCAL runner path; GitHub has none, so a project shipping
  // generated workflows showed no forge pill at all. Since #164 behold can
  // DISPATCH a run — through the operator's own `gh` login, never a stored
  // token — so the pill carries whether that trigger is available: `gh`
  // present and authenticated reads on-demand, anything else is blocked with
  // the reason the dispatch would have refused with.
  if (existsSync(join(projectDir, ".github", "workflows"))) {
    const gh = await run("gh", ["auth", "status"]);
    const ready = gh.code === 0;
    subs.push({
      name: "github",
      label: "GitHub Actions",
      status: ready ? "on-demand" : "blocked",
      detail: ready
        ? "workflows committed — dispatch via your gh login (⌘K)"
        : gh.code === 127
          ? "gh not installed — the dispatch runs through YOUR gh login"
          : "gh not authenticated — run `gh auth login`",
    });
  }

  // Temporal (#74) — chant's Ops execute as Temporal workflows, and `chant run`
  // refuses outright without a `temporal.profiles` block (the exact failure
  // observed live: "No temporal.profiles found in chant.config.ts"). A pill
  // that says so beats every Run/Deploy gesture failing with a chant error.
  // Best-effort text scan, same posture as `projectLexicons`.
  if (lexicons.includes("temporal")) {
    let hasProfiles = false;
    try {
      hasProfiles = /temporal\s*:\s*\{[\s\S]{0,400}?profiles\s*:/.test(readFileSync(join(projectDir, "chant.config.ts"), "utf-8"));
    } catch {
      /* unreadable config — report the actionable absence below */
    }
    subs.push({
      name: "temporal",
      label: "Temporal",
      status: hasProfiles ? "on-demand" : "blocked",
      detail: hasProfiles
        ? "profiles declared — Ops run on the bound Temporal"
        : "no temporal.profiles in chant.config.ts — chant run will refuse",
    });
  }

  // Helm (behold#146) — only for a helm-lexicon project. Not a daemon: a
  // release is installed by a `helm upgrade` run, so presence of the binary
  // plus a reachable kube context reads "on-demand" (like the forges), never
  // a false "down". No bring-up — there is nothing to boot.
  //
  // The context shown is the PROJECT'S binding when the caller resolved one
  // (`k8s.profiles.<env>.context` — what chant's helm reads actually use,
  // chant#1488), falling back to the ambient current-context. Probing only
  // ambient reported whatever cluster the operator's shell last pointed at —
  // observed live: a kubemicrovm-ops estate bound to `k3d-kubemicrovm-local`
  // whose pill named a real EKS cluster.
  //
  // The ambient read is a kubeconfig read, not a shell-out (#231): helm being
  // installed no longer implies kubectl is, and the pill should not go blank
  // on a machine that only ever installed helm.
  if (lexicons.includes("helm")) {
    const helm = await run("helm", ["version", "--short"]);
    const ambient = helm.code === 0 && !boundContext ? await ambientContext() : undefined;
    const ctx = boundContext ?? ambient ?? "";
    subs.push({
      name: "helm",
      label: "Helm",
      status: helm.code === 127 ? "unknown" : ctx ? "on-demand" : "blocked",
      detail:
        helm.code === 127
          ? "helm not installed"
          : ctx
            ? `${helm.out.trim()} · context ${ctx}${boundContext ? " (bound)" : ""}`
            : "no kube context",
    });
  }

  return subs;
}
