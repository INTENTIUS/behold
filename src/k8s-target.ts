/**
 * The k8s substrate's target, resolved from a kubeconfig at runtime (#106).
 *
 * ## What the issue asked for, and what turned out to be true
 *
 * #106 says behold "must derive the k8s substrate target from that kubeconfig
 * at runtime, not a fixed port, or it cannot observe the k8s workload", and
 * that it should "register k8s as a per-component target on that dynamic
 * endpoint (extends #99)".
 *
 * Verified against a real Floci-backed EKS cluster before writing this, and
 * two parts of that are not so:
 *
 * 1. **There is no fixed k8s port to replace.** #99's table
 *    (src/targets.ts `SUBSTRATE_TARGET_VARS`) has no k8s entry at all — it maps
 *    a lexicon to the ambient endpoint variable its read path honours, and k8s
 *    has none.
 * 2. **chant already observes the workload with no hardcoded port.** Its k8s
 *    reader binds `--env <env>` to `k8s.profiles.<env>.context` in the
 *    project's `chant.config.ts` (lexicons/k8s/src/config.ts) and resolves the
 *    apiserver from the kubeconfig that context names. With a cluster created
 *    on Floci and `aws eks update-kubeconfig` run, `chant lifecycle diff local
 *    --live` reported both substrates in one pass — the AWS half plus
 *    `apiService` newly observed with six property drifts — through an
 *    apiserver on a port Floci allocated at cluster creation. #106's
 *    acceptance criterion is met at the chant layer today.
 *
 * So this cannot "extend #99" the way the issue describes: #99's mechanism is
 * an ambient endpoint variable behold overrides on the shell-out, and k8s has
 * neither that variable nor a `--context` flag on the commands behold shells
 * (`graph`, `lifecycle diff`, `components status`). behold cannot route the
 * k8s read, and should not pretend to — chant binds it, from config.
 *
 * ## What was actually missing
 *
 * behold could not SEE the binding. The target lens showed aws and azure and
 * nothing for k8s, so an operator had no way to know which cluster the k8s half
 * was being read from — and when the binding is wrong chant raises
 * `ClusterBindingMismatchError`, which arrives here as an opaque NOT-OBSERVED
 * with no hint that a context is the cause.
 *
 * This module resolves that binding read-only: the bound context, the apiserver
 * behind it, and whether it points at the managed cluster actually in the
 * graph. The endpoint is read from the kubeconfig every time rather than
 * assumed, which is the "no hardcoded k8s port" the acceptance criterion is
 * after — on the reporting side, since the reading side already had it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A project's `k8s.profiles` — environment name → bound kubeconfig context. */
export type K8sProfiles = Record<string, { context?: string } | undefined>;

/** What behold can say about the k8s substrate's binding for one environment. */
export interface K8sTarget {
  /** Substrate key, matching `SubstrateTarget.name` in src/targets.ts. */
  name: "k8s";
  /** The bound kubeconfig context — the label an operator recognises. */
  label: string;
  /** The apiserver URL that context resolves to, read from the kubeconfig. */
  endpoint: string;
  /** Where the binding came from, so the UI never implies behold chose it. */
  source: "profile" | "current-context";
}

/** A parsed kubeconfig, reduced to the two maps this needs. */
export interface Kubeconfig {
  /** context name → cluster name. */
  contexts: Map<string, string>;
  /** cluster name → apiserver URL. */
  servers: Map<string, string>;
  currentContext?: string;
}

const EMPTY: Kubeconfig = { contexts: new Map(), servers: new Map() };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Shape of `kubectl config view --raw -o json`, reduced to what this reads. */
interface KubectlConfigJson {
  contexts?: Array<{ name?: unknown; context?: { cluster?: unknown } }>;
  clusters?: Array<{ name?: unknown; cluster?: { server?: unknown } }>;
  "current-context"?: unknown;
}

/** Build the context → cluster → server chain from kubectl's own JSON view. */
export function readKubeconfigJson(json: KubectlConfigJson): Kubeconfig {
  const contexts = new Map<string, string>();
  for (const entry of json.contexts ?? []) {
    const name = str(entry?.name);
    const cluster = str(entry?.context?.cluster);
    if (name && cluster) contexts.set(name, cluster);
  }
  const servers = new Map<string, string>();
  for (const entry of json.clusters ?? []) {
    const name = str(entry?.name);
    const server = str(entry?.cluster?.server);
    if (name && server) servers.set(name, server);
  }
  const current = str(json["current-context"]);
  return { contexts, servers, ...(current ? { currentContext: current } : {}) };
}

/**
 * Load the kubeconfig by asking kubectl for it, rather than parsing YAML here.
 *
 * Two reasons, and the second is not a preference:
 *
 * 1. kubectl owns the merge. `KUBECONFIG` is a path LIST with first-wins
 *    precedence per name; reimplementing that is a way to resolve a different
 *    context than the one chant will actually bind, which would make this
 *    report confidently wrong.
 * 2. chant's own `parseYAML` (`@intentius/chant/yaml`) cannot read a
 *    kubeconfig. A list item whose FIRST key is a nested mapping loses every
 *    sibling key after it — `- context:\n    cluster: c1\n  name: n1` parses
 *    to `{context:{cluster:"c1"}}` with no `name`, while the same keys in the
 *    other order parse fine. kubectl writes contexts and clusters in exactly
 *    the losing order, so every entry came back nameless and unjoinable.
 *    Reported separately; routing around it here rather than blocking #106 on
 *    a parser fix.
 *
 * No kubectl on PATH, or no kubeconfig, yields an empty result — an ordinary
 * state for an aws-only project, and never a reason to fail the target lens.
 */
export async function loadKubeconfig(exec: (cmd: string, args: string[]) => Promise<string> = defaultExec): Promise<Kubeconfig> {
  try {
    const stdout = await exec("kubectl", ["config", "view", "--raw", "-o", "json"]);
    return readKubeconfigJson(JSON.parse(stdout) as KubectlConfigJson);
  } catch {
    return EMPTY;
  }
}

async function defaultExec(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await run(cmd, args, { encoding: "utf8", timeout: 10_000 });
  return stdout;
}

/**
 * The k8s target for one environment: the context chant will bind (the
 * project's `k8s.profiles.<env>.context`, else the kubeconfig's
 * current-context, which is chant's own fallback when no profile is declared)
 * and the apiserver it resolves to.
 *
 * `undefined` when there is no binding to report or the context names a cluster
 * the kubeconfig doesn't carry — an unresolvable binding is not a target, and
 * saying nothing is better than naming an endpoint that isn't there.
 */
export function resolveK8sTarget(
  profiles: K8sProfiles | undefined,
  env: string | undefined,
  kubeconfig: Kubeconfig,
): K8sTarget | undefined {
  const declared = env ? profiles?.[env]?.context : undefined;
  const context = declared ?? kubeconfig.currentContext;
  if (!context) return undefined;
  const cluster = kubeconfig.contexts.get(context);
  const endpoint = cluster ? kubeconfig.servers.get(cluster) : undefined;
  if (!endpoint) return undefined;
  return { name: "k8s", label: context, endpoint, source: declared ? "profile" : "current-context" };
}

/**
 * Does a kubeconfig context point at the managed cluster named `clusterName`?
 *
 * Each cloud's credential helper names the context differently, and all three
 * embed the cluster name as a delimited segment:
 *
 *   EKS  `arn:aws:eks:us-east-1:000000000000:cluster/cc-eks`   (verified on Floci)
 *   GKE  `gke_my-project_us-central1_my-cluster`
 *   AKS  `my-cluster`
 *
 * Matching on a delimited segment rather than a substring keeps `prod` from
 * matching a context bound to `prod-replica`. Returns `undefined` when there is
 * nothing to compare, so a caller can distinguish "no opinion" from "mismatch".
 */
export function contextBindsCluster(context: string, clusterName: string | undefined): boolean | undefined {
  if (!clusterName) return undefined;
  return context.split(/[/_:@]/).includes(clusterName);
}
