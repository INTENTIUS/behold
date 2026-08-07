import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { mergeClusterRoot, runningK3dClusters, k3dClusterName } from "./cluster-root.ts";

const clusterIr = (): GraphIR => ({
  nodes: [
    {
      id: "localCluster",
      kind: "K3d::Cluster",
      lexicon: "k3d",
      attrs: { metadata: { name: "kubemicrovm-local" }, servers: 1, agents: 1 },
    },
  ],
  edges: [],
  groups: {},
});

const mainIr = (): GraphIR => ({
  nodes: [{ id: "m80Deploy", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: {} }],
  edges: [],
  groups: {},
});

describe("mergeClusterRoot", () => {
  it("appends the cluster root's nodes and edges", () => {
    const ir = mergeClusterRoot(mainIr(), clusterIr());
    expect(ir.nodes.map((n) => n.id)).toEqual(["m80Deploy", "localCluster"]);
  });

  it("no cluster root is a no-op", () => {
    const ir = mainIr();
    expect(mergeClusterRoot(ir, undefined)).toBe(ir);
    expect(ir.nodes).toHaveLength(1);
  });

  it("skips a node the main graph already carries (the main graph wins)", () => {
    const ir = mainIr();
    ir.nodes.push({ id: "localCluster", kind: "K3d::Cluster", lexicon: "k3d", attrs: { _status: "good" } });
    mergeClusterRoot(ir, clusterIr());
    expect(ir.nodes.filter((n) => n.id === "localCluster")).toHaveLength(1);
    expect(ir.nodes.find((n) => n.id === "localCluster")!.attrs?._status).toBe("good");
  });

  it("paints a running declared cluster good, an absent one accent", () => {
    const running = new Map([["kubemicrovm-local", true]]);
    const up = mergeClusterRoot(mainIr(), clusterIr(), running);
    expect(up.nodes.find((n) => n.id === "localCluster")!.attrs?._status).toBe("good");

    const down = mergeClusterRoot(mainIr(), clusterIr(), new Map());
    expect(down.nodes.find((n) => n.id === "localCluster")!.attrs?._status).toBe("accent");
  });

  it("leaves the cluster unpainted on a source-only view (no probe result)", () => {
    const ir = mergeClusterRoot(mainIr(), clusterIr(), undefined);
    expect(ir.nodes.find((n) => n.id === "localCluster")!.attrs?._status).toBeUndefined();
  });
});

describe("runningK3dClusters", () => {
  it("parses names and running servers from `k3d cluster list --no-headers`", async () => {
    const out = "kubemicrovm-local   1/1       1/1      true\nstopped-one   0/1   0/0   true\n";
    const clusters = await runningK3dClusters(async () => out);
    expect(clusters?.get("kubemicrovm-local")).toBe(true);
    expect(clusters?.get("stopped-one")).toBe(false);
  });

  it("k3d unavailable yields undefined — no opinion, never absence", async () => {
    expect(
      await runningK3dClusters(async () => {
        throw new Error("not installed");
      }),
    ).toBeUndefined();
  });
});

describe("k3dClusterName", () => {
  it("reads metadata.name, falling back to the node id", () => {
    expect(k3dClusterName({ id: "x", attrs: { metadata: { name: "fountain-local" } } })).toBe("fountain-local");
    expect(k3dClusterName({ id: "x", attrs: {} })).toBe("x");
  });
});
