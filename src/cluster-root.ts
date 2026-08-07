/**
 * The cluster build root, merged into the served view.
 *
 * A k3d/floci-backed estate declares its local cluster as chant source in its
 * own build root (`cluster/`, outside `sourceDir` — the fountain-ops /
 * kubemicrovm-ops shape), so no behold view ever saw the `K3d::Cluster`
 * declaration: the k8s half rendered inside a synthetic `cluster <env>` box
 * while the actual cluster node sat ungraphed. `chant.ts`'s
 * `clusterRootGraphIr` reads that root; this module merges it into the main
 * IR and paints the merged cluster nodes from the one live signal behold
 * already has for k3d — `k3d cluster list`.
 *
 * The paint is deliberately coarse: a declared cluster that is running reads
 * `good`, one that is not reads `accent` (declared, not created — the same
 * word the entity overlay uses for pending). No painting on source-only views
 * (`running === undefined`), where nothing else carries status either.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GraphIR } from "@intentius/chant";

const run = promisify(execFile);

/** `k3d cluster list --no-headers` reduced to name → has a running server. */
export async function runningK3dClusters(
  exec: (cmd: string, args: string[]) => Promise<string> = defaultExec,
): Promise<Map<string, boolean> | undefined> {
  try {
    const out = await exec("k3d", ["cluster", "list", "--no-headers"]);
    const clusters = new Map<string, boolean>();
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (!cols[0]) continue;
      // SERVERS reads `1/1` (running) or `0/1` (stopped). A row without the
      // column (older k3d) counts as running — the cluster exists.
      const servers = cols[1] ?? "";
      const m = /^(\d+)\/(\d+)$/.exec(servers);
      clusters.set(cols[0], m ? Number(m[1]) > 0 : true);
    }
    return clusters;
  } catch {
    // k3d not installed / docker down — no opinion, never "absent".
    return undefined;
  }
}

async function defaultExec(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await run(cmd, args, { encoding: "utf8", timeout: 10_000 });
  return stdout;
}

/** The name a `K3d::Cluster` node declares (`metadata.name`), else its id. */
export function k3dClusterName(node: { id: string; attrs?: Record<string, unknown> }): string {
  const meta = node.attrs?.metadata as Record<string, unknown> | undefined;
  const name = meta?.name;
  return typeof name === "string" && name.length > 0 ? name : node.id;
}

/**
 * Merge the cluster root's nodes/edges into `ir`, in place, and paint each
 * merged `K3d::Cluster` from `running` when the caller has it. Id collisions
 * are skipped (the main graph wins — it may carry live attrs). Returns `ir`.
 */
export function mergeClusterRoot(
  ir: GraphIR,
  clusterIr: GraphIR | undefined,
  running?: Map<string, boolean>,
): GraphIR {
  if (!clusterIr) return ir;
  const have = new Set(ir.nodes.map((n) => n.id));
  for (const node of clusterIr.nodes) {
    if (have.has(node.id)) continue;
    if (node.kind === "K3d::Cluster" && running !== undefined) {
      const attrs = (node.attrs ??= {});
      const up = running.get(k3dClusterName(node));
      attrs._status = up ? "good" : "accent";
    }
    ir.nodes.push(node);
    have.add(node.id);
  }
  const haveEdges = new Set(ir.edges.map((e) => `${e.from}\0${e.to}`));
  for (const edge of clusterIr.edges) {
    const key = `${edge.from}\0${edge.to}`;
    if (haveEdges.has(key)) continue;
    haveEdges.add(key);
    ir.edges.push(edge);
  }
  return ir;
}
