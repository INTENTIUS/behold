/**
 * `behold doctor` (#236) — the read-only first-touch diagnosis.
 *
 * #193 got a stranger from "blank graph" to "structured error". The next
 * question is *why*, and the answers were scattered across error payloads,
 * zoom notes and server logs. This gathers them into one console report: seven
 * lines, each pass/warn/fail with a one-line fix, exit 0 iff nothing failed.
 *
 * It is deliberately a REUSE surface, not a second implementation. Every fact
 * here comes from the module the server already reads it from — `project.ts`
 * for the shape and the config, `chant.ts` for the bin/version/lexicon
 * resolution behold will actually shell, `k8s-target.ts` for the cluster
 * binding (the same kubectl-owned merge, never a parallel kubeconfig parser),
 * `substrates.ts` for readiness, `ops.ts` for committed Ops. Where a check
 * needed logic the server didn't have (estate shape, chant version vs floor,
 * lexicon install state), that logic went into the shared module and the
 * server's own paths resolve through it too.
 *
 * Read-only throughout: no writes, no cluster mutations, no network beyond
 * what a `behold serve` of the same directory would already do.
 *
 * The severity convention is the whole point of the output being useful:
 *   fail — behold cannot serve this project well, and the fix is named.
 *   warn — behold serves, with less: the declared graph is still a graph.
 *          A missing cluster binding is a warn for exactly this reason.
 *   pass — nothing to do.
 */
import { relative, resolve } from "node:path";
import {
  chantFloor,
  meetsFloor,
  resolveChant,
  resolveLexicons,
  type ChantResolution,
} from "./chant.ts";
import { detectProject, detectProjectShape, type ProjectKind } from "./project.ts";
import { loadKubeconfig, resolveK8sTarget, type K8sProfiles, type Kubeconfig } from "./k8s-target.ts";
import { detectSubstrates, type Substrate } from "./substrates.ts";
import { discoverEstateOps, type OpInfo } from "./ops.ts";
import { beholdVersion } from "./server.ts";

export type CheckStatus = "pass" | "warn" | "fail";

/** One diagnosis line. `name` is a stable machine key (`--json` consumers key
 * on it); `detail` is what behold found; `fix` is the single next step, set
 * whenever the status isn't a pass. */
export interface DoctorCheck {
  name: "project" | "chant" | "lexicons" | "envs" | "kube" | "substrates" | "ops";
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  /** behold's own version — the thing doing the diagnosing. */
  behold: string;
  /** The directory diagnosed, absolute. */
  dir: string;
  kind: ProjectKind;
  /** True iff no check failed — the process exit code is `ok ? 0 : 1`. */
  ok: boolean;
  checks: DoctorCheck[];
}

/** The two live probes, injectable so the diagnosis is testable without a
 * Docker daemon or a kubeconfig on the machine running the tests. Defaults are
 * the real ones the server uses. */
export interface DoctorProbes {
  loadKubeconfig?: () => Promise<Kubeconfig>;
  detectSubstrates?: (projectDir: string, preview?: boolean, boundContext?: string) => Promise<Substrate[]>;
}

const list = (xs: readonly string[]): string => xs.join(", ");

const EMPTY_KUBECONFIG: Kubeconfig = { contexts: new Map(), servers: new Map() };

/** A long list, cut to a readable few — an operator with 14 kubeconfig
 * contexts doesn't need all of them inside a fix line. */
function summarize(xs: readonly string[], max = 4): string {
  return xs.length <= max ? list(xs) : `${list(xs.slice(0, max))}, +${xs.length - max} more`;
}

/** Member label for a detail line: the relative dir inside an estate, and
 * nothing at all for a single project (where there's only one target and
 * naming it every time is noise). */
function labelFor(root: string, target: string, estate: boolean): string {
  if (!estate) return "";
  const rel = relative(root, target);
  return `${rel || "."}: `;
}

/** The chant line: the install behold will actually shell for each target, and
 * its version against behold's declared floor. A project with no chant of its
 * own is the #1 first-touch failure — behold falls back to its own bundled
 * chant, which carries none of the project's lexicons, and the failure surfaces
 * much later as an opaque graph error. */
function chantCheck(root: string, targets: string[], estate: boolean): DoctorCheck {
  const floor = chantFloor();
  const resolutions = targets.map((t) => ({ target: t, res: resolveChant(t) }));
  const missing = resolutions.filter(({ res }) => res.source !== "project");
  const describe = ({ target, res }: { target: string; res: ChantResolution }): string =>
    `${labelFor(root, target, estate)}${res.source === "project" ? `chant ${res.version ?? "(unknown version)"}` : "no chant installed"}`;
  if (missing.length) {
    return {
      name: "chant",
      status: "fail",
      detail: `${list(resolutions.map(describe))} — behold shells the project's own chant`,
      fix: `Run \`npm install\` in ${list(missing.map(({ target }) => relative(root, target) || target))}`,
    };
  }
  const stale = resolutions.filter(({ res }) => !meetsFloor(res.version, floor));
  const versions = list(resolutions.map(describe));
  if (stale.length) {
    return {
      name: "chant",
      status: "warn",
      detail: `${versions} — below behold's floor ${floor}`,
      fix: "Bump @intentius/chant in the project (`npm install @intentius/chant@latest`) — older versions observe less.",
    };
  }
  return { name: "chant", status: "pass", detail: `${versions}${floor ? ` (behold's floor ${floor})` : ""}` };
}

/** The lexicons line: what the config declares against what's installed. A
 * declared-but-missing lexicon is the same "not-installed" chant would raise
 * at graph time, said before a graph route has to. */
function lexiconCheck(root: string, declared: Map<string, string[]>, estate: boolean): DoctorCheck {
  const missing: string[] = [];
  const found: string[] = [];
  for (const [target, lexicons] of declared) {
    const label = labelFor(root, target, estate);
    for (const r of resolveLexicons(target, lexicons)) {
      (r.installed ? found : missing).push(`${label}${r.lexicon}${r.installed && r.version ? ` ${r.version}` : ""}`);
    }
  }
  if (missing.length) {
    return {
      name: "lexicons",
      status: "fail",
      detail: `declared but not installed: ${list(missing)}${found.length ? ` (installed: ${list(found)})` : ""}`,
      fix: "Run `npm install` in the project — chant can't graph source importing a lexicon it can't resolve.",
    };
  }
  if (!found.length) {
    return { name: "lexicons", status: "pass", detail: "none declared" };
  }
  return { name: "lexicons", status: "pass", detail: `${found.length} installed: ${list(found)}` };
}

/** The envs line: what the env picker will infer. No envs is not broken — it
 * means no live overlay, stated plainly instead of discovered by an empty
 * dropdown. */
function envCheck(envs: string[], serveArg: string): DoctorCheck {
  if (!envs.length) {
    return {
      name: "envs",
      status: "warn",
      detail: "no environments declared — the declared graph serves, but there is no live overlay to pick",
      fix: "Declare `environments` (or `k8s.profiles`) in chant.config.ts, then serve with `--env <name>`.",
    };
  }
  return { name: "envs", status: "pass", detail: `${list(envs)} — \`behold serve ${serveArg} --env ${envs[0]}\` for the live overlay` };
}

/** The kube line: the context chant will bind per environment, and whether the
 * ambient context agrees with it.
 *
 * Never a fail. A project whose cluster is unreachable still has a declared
 * graph worth serving, and kubectl's absence is an ordinary state for a
 * project served source-only. The mismatch case is a warn rather than silence
 * because chant refuses a live read outright when the ambient context differs
 * from the declared binding (chant#1100) — an opaque "unobserved" downstream.
 */
function kubeCheck(lexicons: string[], profiles: K8sProfiles, envs: string[], kubeconfig: Kubeconfig): DoctorCheck {
  if (!lexicons.includes("k8s") && !lexicons.includes("helm")) {
    return { name: "kube", status: "pass", detail: "no k8s or helm lexicon — no cluster binding to check" };
  }
  const ambient = kubeconfig.currentContext;
  if (!kubeconfig.contexts.size) {
    return {
      name: "kube",
      status: "warn",
      detail: "no kubeconfig readable (kubectl absent, or it has no contexts) — the declared graph still serves",
      fix: "Install kubectl and point KUBECONFIG at your cluster, or run `behold demo k8s` for a throwaway k3d one.",
    };
  }
  const bound = envs.filter((e) => profiles[e]?.context);
  if (!bound.length) {
    return {
      name: "kube",
      status: "warn",
      detail: `no k8s.profiles binding — chant falls back to the ambient current-context${ambient ? ` (${ambient})` : " (none set)"}`,
      fix: "Declare `k8s.profiles.<env>.context` in chant.config.ts so the cluster the reads hit is explicit, not ambient.",
    };
  }
  const lines: string[] = [];
  const unresolved: string[] = [];
  const mismatched: string[] = [];
  for (const env of bound) {
    const context = profiles[env]!.context!;
    const target = resolveK8sTarget(profiles, env, kubeconfig);
    if (!target) {
      unresolved.push(`${env}: ${context}`);
      continue;
    }
    lines.push(`${env}: ${target.label} at ${target.endpoint}`);
    if (ambient && ambient !== target.label) mismatched.push(`${env}: ${target.label}`);
  }
  if (unresolved.length) {
    return {
      name: "kube",
      status: "warn",
      detail: `context not in the kubeconfig — ${list(unresolved)}${lines.length ? `; bound: ${list(lines)}` : ""}`,
      fix: `Add the context to your kubeconfig, or point k8s.profiles at one you have (${summarize([...kubeconfig.contexts.keys()])}).`,
    };
  }
  if (mismatched.length) {
    return {
      name: "kube",
      status: "warn",
      detail: `bound ${list(lines)}, but the ambient current-context is ${ambient} — chant refuses a live read on a mismatch`,
      fix: `Run \`kubectl config use-context ${mismatched[0]!.split(": ")[1]}\` before the live overlay.`,
    };
  }
  return { name: "kube", status: "pass", detail: `bound ${list(lines)}` };
}

/** The substrates line: exactly what `/api/substrates` would report, without
 * starting a server. Never a fail — a down emulator costs the live half, not
 * the graph. */
function substrateCheck(substrates: Substrate[]): DoctorCheck {
  if (!substrates.length) return { name: "substrates", status: "pass", detail: "none needed by this project" };
  const detail = list(substrates.map((s) => `${s.label} ${s.status}`));
  const down = substrates.filter((s) => s.status === "down" || s.status === "blocked");
  if (!down.length) return { name: "substrates", status: "pass", detail };
  const named = down.map((s) => `${s.label} (${s.bringUp ? `${s.bringUp.cmd} ${s.bringUp.args.join(" ")}` : s.detail})`);
  return {
    name: "substrates",
    status: "warn",
    detail,
    fix: `Bring up: ${list(named)} — or \`behold serve <dir> --local\`, which boots the project's own emulators (needs Docker).`,
  };
}

/** The ops line: the committed Ops behold can trigger, and whether chant's MCP
 * (where the mutating tools live) is reachable at all — it is the project's own
 * chant that serves it, so a missing install takes the act loop with it. */
function opsCheck(root: string, ops: OpInfo[], chantSource: ChantResolution["source"], estate: boolean): DoctorCheck {
  const mcp =
    chantSource === "project"
      ? "chant MCP available (the project's own chant)"
      : "chant MCP unavailable until the project's chant is installed";
  if (!ops.length) {
    return {
      name: "ops",
      status: "warn",
      detail: `no committed Ops (*.op.ts) — behold can show drift but has nothing to trigger; ${mcp}`,
      fix: "Add an ApplyOp (code to cloud) or ReconcileOp (cloud to PR) under ops/ — behold triggers your Ops, it holds no apply creds.",
    };
  }
  const names = ops.map((o) => `${labelFor(root, o.dir, estate)}${o.name} (${o.kind})`);
  return { name: "ops", status: "pass", detail: `${ops.length} committed: ${list(names)}; ${mcp}` };
}

/**
 * Diagnose a directory. Read-only; resolves every fact through the module the
 * server reads it from. A directory that is neither a chant project nor an
 * estate root returns the single `project` fail — every later line would be a
 * report about nothing.
 */
export async function diagnose(dir: string, probes: DoctorProbes = {}): Promise<DoctorReport> {
  const root = resolve(dir);
  const shape = detectProjectShape(root);
  const behold = beholdVersion();

  if (shape.kind === "none") {
    return {
      behold,
      dir: root,
      kind: "none",
      ok: false,
      checks: [
        {
          name: "project",
          status: "fail",
          detail: `no chant.config.ts here, and no estate members declared (.behold.json \`members\`, or npm workspaces)`,
          fix: "Point behold at a chant project (`behold doctor <dir>`), or run `behold demo` for a bundled working example.",
        },
      ],
    };
  }

  const estate = shape.kind === "estate";
  const members = (shape.members ?? []).map((m) => resolve(root, m));
  const targets = estate ? members : [root];
  const primary = targets[0]!;

  const projectCheck: DoctorCheck = estate
    ? {
        name: "project",
        status: "pass",
        detail: `estate of ${members.length} projects (${shape.membersFrom === "behold-config" ? ".behold.json members" : "npm workspaces"}): ${list(
          members.map((m) => relative(root, m)),
        )}`,
      }
    : { name: "project", status: "pass", detail: `chant project (${relative(root, shape.configFile!)})` };

  // One config read per target, shared by the lexicon/env/kube lines — the
  // same `detectProject` the server's pickers are built from.
  const infos = await Promise.all(targets.map(async (t) => ({ target: t, info: await detectProject(t) })));
  const declared = new Map(infos.map(({ target, info }) => [target, info.lexicons] as const));
  const lexicons = [...new Set(infos.flatMap(({ info }) => info.lexicons))];
  const envs = [...new Set(infos.flatMap(({ info }) => info.environments))];
  const profiles: K8sProfiles = {};
  for (const { info } of infos) for (const [env, p] of Object.entries(info.k8sProfiles ?? {})) profiles[env] ??= p;

  const kubeconfig = lexicons.includes("k8s") || lexicons.includes("helm") ? await (probes.loadKubeconfig ?? loadKubeconfig)() : EMPTY_KUBECONFIG;
  const kube = kubeCheck(lexicons, profiles, envs, kubeconfig);
  // The bound context threads into the substrate probe exactly as it does in
  // the server's /api/substrates route — so the Helm pill names the project's
  // cluster, not whatever the operator's shell last pointed at.
  const boundContext = resolveK8sTarget(profiles, envs[0], kubeconfig)?.label;
  const substrates = await (probes.detectSubstrates ?? detectSubstrates)(primary, false, boundContext);

  const checks: DoctorCheck[] = [
    projectCheck,
    chantCheck(root, targets, estate),
    lexiconCheck(root, declared, estate),
    // An estate root is not itself servable — the hint has to name its members
    // (`behold serve a b c`, #31), which is what a stranger would otherwise
    // discover by having the root serve nothing.
    envCheck(envs, estate ? shape.members!.map((m) => `${dir.replace(/\/$/, "")}/${m}`).join(" ") : dir),
    kube,
    substrateCheck(substrates),
    opsCheck(root, discoverEstateOps(targets), resolveChant(primary).source, estate),
  ];

  return { behold, dir: root, kind: shape.kind, ok: !checks.some((c) => c.status === "fail"), checks };
}

/** Render a report for a terminal. Plain text, no colour: the output is meant
 * to be pasted into an issue as readily as read. */
export function formatReport(report: DoctorReport): string {
  const lines = [`behold doctor ${report.behold} — ${report.dir}`, ""];
  for (const c of report.checks) {
    lines.push(`  ${c.status.padEnd(4)}  ${c.name.padEnd(10)}  ${c.detail}`);
    if (c.fix) lines.push(`        ${"fix".padEnd(10)}  ${c.fix}`);
  }
  const tally = (s: CheckStatus): number => report.checks.filter((c) => c.status === s).length;
  lines.push("", `  ${tally("pass")} pass, ${tally("warn")} warn, ${tally("fail")} fail`, "");
  return lines.join("\n");
}
