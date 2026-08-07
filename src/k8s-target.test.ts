import { describe, it, expect } from "vitest";
import { readKubeconfigJson, loadKubeconfig, resolveK8sTarget, contextBindsCluster } from "./k8s-target.ts";

// Verbatim shape of `kubectl config view --raw -o json` for the Floci-backed
// EKS cluster this was verified against: `aws eks update-kubeconfig --name
// cc-eks` names the context by cluster ARN, and Floci allocated :6500 at
// cluster creation — a different port next time, which is the whole point.
const EKS_JSON = {
  contexts: [
    {
      name: "arn:aws:eks:us-east-1:000000000000:cluster/cc-eks",
      context: { cluster: "arn:aws:eks:us-east-1:000000000000:cluster/cc-eks" },
    },
  ],
  clusters: [
    {
      name: "arn:aws:eks:us-east-1:000000000000:cluster/cc-eks",
      cluster: { server: "https://localhost:6500" },
    },
  ],
  "current-context": "arn:aws:eks:us-east-1:000000000000:cluster/cc-eks",
};
const EKS_CONTEXT = "arn:aws:eks:us-east-1:000000000000:cluster/cc-eks";

describe("readKubeconfigJson", () => {
  it("builds the context → cluster → server chain", () => {
    const kc = readKubeconfigJson(EKS_JSON);
    expect(kc.contexts.get(EKS_CONTEXT)).toBe(EKS_CONTEXT);
    expect(kc.servers.get(EKS_CONTEXT)).toBe("https://localhost:6500");
    expect(kc.currentContext).toBe(EKS_CONTEXT);
  });

  it("skips entries missing a name or a server rather than half-building them", () => {
    const kc = readKubeconfigJson({
      contexts: [{ context: { cluster: "c" } }, { name: "ok", context: { cluster: "c" } }],
      clusters: [{ name: "c" }, { name: "c2", cluster: { server: "https://h:1" } }],
    });
    expect([...kc.contexts.keys()]).toEqual(["ok"]);
    expect([...kc.servers.keys()]).toEqual(["c2"]);
  });

  it("survives an empty or fieldless config", () => {
    const kc = readKubeconfigJson({});
    expect(kc.contexts.size).toBe(0);
    expect(kc.currentContext).toBeUndefined();
  });
});

describe("loadKubeconfig", () => {
  it("asks kubectl for the merged view", async () => {
    const calls: Array<[string, string[]]> = [];
    const kc = await loadKubeconfig(async (cmd, args) => {
      calls.push([cmd, args]);
      return JSON.stringify(EKS_JSON);
    });
    expect(calls).toEqual([["kubectl", ["config", "view", "--raw", "-o", "json"]]]);
    expect(kc.currentContext).toBe(EKS_CONTEXT);
  });

  it("returns empty when kubectl is absent — an aws-only project must not break the target lens", async () => {
    const kc = await loadKubeconfig(async () => {
      throw Object.assign(new Error("spawn kubectl ENOENT"), { code: "ENOENT" });
    });
    expect(kc.contexts.size).toBe(0);
    expect(kc.servers.size).toBe(0);
  });

  it("returns empty on unparseable output rather than throwing", async () => {
    expect((await loadKubeconfig(async () => "not json")).contexts.size).toBe(0);
  });
});

describe("resolveK8sTarget (#106)", () => {
  const kc = readKubeconfigJson(EKS_JSON);

  it("resolves the declared profile context to the apiserver the kubeconfig names", () => {
    const t = resolveK8sTarget({ local: { context: EKS_CONTEXT } }, "local", kc);
    expect(t).toEqual({ name: "k8s", label: EKS_CONTEXT, endpoint: "https://localhost:6500", source: "profile" });
  });

  it("reads the port from the kubeconfig rather than assuming one — the acceptance criterion", () => {
    // Floci allocates the apiserver port per cluster, so nothing may hardcode
    // it. Same cluster, different port, and the target follows.
    const moved = readKubeconfigJson({ ...EKS_JSON, clusters: [{ name: EKS_CONTEXT, cluster: { server: "https://localhost:7311" } }] });
    expect(resolveK8sTarget({ local: { context: EKS_CONTEXT } }, "local", moved)?.endpoint).toBe("https://localhost:7311");
  });

  it("falls back to the kubeconfig's current-context, which is chant's own fallback with no profile", () => {
    const t = resolveK8sTarget(undefined, "local", kc);
    expect(t?.label).toBe(EKS_CONTEXT);
    expect(t?.source).toBe("current-context");
  });

  it("reports nothing when the bound context isn't in the kubeconfig — never a made-up endpoint", () => {
    expect(resolveK8sTarget({ local: { context: "some-other-cluster" } }, "local", kc)).toBeUndefined();
  });

  it("reports nothing when the kubeconfig is empty — no context, no current-context, nothing to name", () => {
    const bare = readKubeconfigJson({});
    expect(resolveK8sTarget(undefined, "local", bare)).toBeUndefined();
    expect(resolveK8sTarget({ local: { context: EKS_CONTEXT } }, "local", bare)).toBeUndefined();
  });

  it("falls back to current-context with no env selected, matching chant's own unbound behaviour", () => {
    // No `--env` means no profile lookup, and chant's k8s reader then uses the
    // ambient kubeconfig context. Reporting that is the honest answer, not
    // reporting nothing.
    expect(resolveK8sTarget({ prod: { context: EKS_CONTEXT } }, undefined, kc)?.source).toBe("current-context");
  });

  it("uses the profile for the CURRENT env, not any profile that happens to exist", () => {
    const profiles = { prod: { context: EKS_CONTEXT } };
    // No `local` profile → falls through to current-context, not prod's.
    expect(resolveK8sTarget(profiles, "local", kc)?.source).toBe("current-context");
  });
});

describe("contextBindsCluster", () => {
  it("recognises each cloud's own context naming", () => {
    expect(contextBindsCluster(EKS_CONTEXT, "cc-eks")).toBe(true);
    expect(contextBindsCluster("gke_my-project_us-central1_my-cluster", "my-cluster")).toBe(true);
    expect(contextBindsCluster("my-cluster", "my-cluster")).toBe(true);
  });

  it("matches a delimited segment, not a substring — prod must not bind prod-replica", () => {
    expect(contextBindsCluster("arn:aws:eks:us-east-1:0:cluster/prod-replica", "prod")).toBe(false);
  });

  it("recognises k3d's prefix convention — cluster names contain hyphens, so no segment split can see it", () => {
    expect(contextBindsCluster("k3d-kubemicrovm-local", "kubemicrovm-local")).toBe(true);
    expect(contextBindsCluster("k3d-fountain-local", "fountain-k8s-stand-in")).toBe(false);
    // The prefix must be exact — `k3d-fountain-local-2` is a different cluster.
    expect(contextBindsCluster("k3d-fountain-local-2", "fountain-local")).toBe(false);
  });

  it("has no opinion when there is no cluster to compare against", () => {
    expect(contextBindsCluster(EKS_CONTEXT, undefined)).toBeUndefined();
  });
});
