/**
 * The k8s target lens, read straight out of kubeconfig files (#231).
 *
 * Every case here writes its own kubeconfig into a temp directory and points
 * `KUBECONFIG` at it, which is `@intentius/chant-k8s-client`'s own test style
 * and the only honest seam left now that nothing is being shelled: the code
 * under test is a file read, so the fixture is a file. Nothing reads the
 * developer's real `~/.kube/config` — the no-kubeconfig case names two paths
 * that do not exist rather than unsetting the variable — and nothing contacts
 * a cluster.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fakeKubeconfig } from "@intentius/chant-k8s-client/testing";
import { kubeconfigFromView, loadKubeconfig, ambientContext, resolveK8sTarget, contextBindsCluster } from "./k8s-target.ts";

// The Floci-backed EKS cluster this lens was verified against: `aws eks
// update-kubeconfig --name cc-eks` names the context by cluster ARN, and Floci
// allocated :6500 at cluster creation — a different port next time, which is
// the whole point.
const EKS_CONTEXT = "arn:aws:eks:us-east-1:000000000000:cluster/cc-eks";
const EKS_VIEW = {
  contexts: [{ name: EKS_CONTEXT, cluster: EKS_CONTEXT, user: "eks-user", server: "https://localhost:6500" }],
  currentContext: EKS_CONTEXT,
};

let dir: string;
let savedKubeconfig: string | undefined;
let savedPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "behold-k8s-target-"));
  savedKubeconfig = process.env.KUBECONFIG;
  savedPath = process.env.PATH;
});

afterEach(() => {
  if (savedKubeconfig === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = savedKubeconfig;
  if (savedPath !== undefined) process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** A one-cluster, one-context kubeconfig with a chosen apiserver — the material
 * the merge cases are reproduced with. */
function configYaml(opts: { cluster: string; server: string; context: string }): string {
  return fakeKubeconfig({
    contexts: [{ name: opts.context, cluster: opts.cluster, user: `user-${opts.context}` }],
    currentContext: opts.context,
    server: opts.server,
  });
}

describe("kubeconfigFromView", () => {
  it("builds the context → cluster → server chain", () => {
    const kc = kubeconfigFromView(EKS_VIEW);
    expect(kc.contexts.get(EKS_CONTEXT)).toBe(EKS_CONTEXT);
    expect(kc.servers.get(EKS_CONTEXT)).toBe("https://localhost:6500");
    expect(kc.currentContext).toBe(EKS_CONTEXT);
  });

  it("keeps a context whose cluster has no address, but records no server for it", () => {
    // The client reports a dangling context rather than failing, and the two
    // maps have to survive that: `contexts` knows the name, `servers` has
    // nothing to say, and resolveK8sTarget then reports no target.
    const kc = kubeconfigFromView({ contexts: [{ name: "dangling", cluster: "gone" }], currentContext: "dangling" });
    expect(kc.contexts.get("dangling")).toBe("gone");
    expect(kc.servers.size).toBe(0);
    expect(resolveK8sTarget(undefined, "local", kc)).toBeUndefined();
  });

  it("survives an empty view", () => {
    const kc = kubeconfigFromView({ contexts: [] });
    expect(kc.contexts.size).toBe(0);
    expect(kc.currentContext).toBeUndefined();
  });
});

describe("loadKubeconfig (#231)", () => {
  it("reads the merged view from the KUBECONFIG the operator has set", async () => {
    process.env.KUBECONFIG = write("eks.yaml", configYaml({ cluster: EKS_CONTEXT, server: "https://localhost:6500", context: EKS_CONTEXT }));

    const kc = await loadKubeconfig();
    expect(kc.currentContext).toBe(EKS_CONTEXT);
    expect(kc.contexts.get(EKS_CONTEXT)).toBe(EKS_CONTEXT);
    expect(kc.servers.get(EKS_CONTEXT)).toBe("https://localhost:6500");
  });

  it("takes current-context from the FIRST file of a KUBECONFIG list, as kubectl does", async () => {
    // `@kubernetes/client-node` on its own takes the LAST — the opposite of
    // every `kubectl get` the operator ran to check. chant#1630 is why this
    // now agrees.
    const a = write("a.yaml", configYaml({ cluster: "cluster-a", server: "https://from-a:6443", context: "ctx-a" }));
    const c = write("c.yaml", configYaml({ cluster: "cluster-c", server: "https://from-c:6443", context: "ctx-c" }));
    process.env.KUBECONFIG = [a, c].join(delimiter);

    expect((await loadKubeconfig()).currentContext).toBe("ctx-a");
    await expect(ambientContext()).resolves.toBe("ctx-a");
  });

  it("keeps the FIRST definition of a duplicated name across the list", async () => {
    // A team-wide file plus a personal one both naming a cluster is ordinary.
    // client-node throws `Duplicate cluster: shared` on it, which used to read
    // as "no kubeconfig at all"; kubectl keeps the first and lists both
    // contexts, and so does this.
    const a = write("a.yaml", configYaml({ cluster: "shared", server: "https://from-a:6443", context: "ctx-a" }));
    const b = write("b.yaml", configYaml({ cluster: "shared", server: "https://from-b:6443", context: "ctx-b" }));
    process.env.KUBECONFIG = [a, b].join(delimiter);

    const kc = await loadKubeconfig();
    expect([...kc.contexts.keys()]).toEqual(["ctx-a", "ctx-b"]);
    expect(kc.servers.get("shared")).toBe("https://from-a:6443");
    // Both contexts name `shared`, so both resolve to the first file's server.
    expect(resolveK8sTarget({ local: { context: "ctx-b" } }, "local", kc)?.endpoint).toBe("https://from-a:6443");
  });

  it("returns empty with no kubeconfig — an aws-only project must not break the target lens", async () => {
    process.env.KUBECONFIG = [join(dir, "nope-a.yaml"), join(dir, "nope-b.yaml")].join(delimiter);

    const kc = await loadKubeconfig();
    expect(kc.contexts.size).toBe(0);
    expect(kc.servers.size).toBe(0);
    expect(kc.currentContext).toBeUndefined();
    await expect(ambientContext()).resolves.toBeUndefined();
  });

  it("honours an explicitly named kubeconfig over the ambient list", async () => {
    process.env.KUBECONFIG = write("ambient.yaml", configYaml({ cluster: "cluster-a", server: "https://from-a:6443", context: "ctx-a" }));
    const explicit = write("explicit.yaml", configYaml({ cluster: "cluster-x", server: "https://from-x:6443", context: "ctx-x" }));

    expect((await loadKubeconfig({ kubeconfigPath: explicit })).currentContext).toBe("ctx-x");
    await expect(ambientContext({ kubeconfigPath: explicit })).resolves.toBe("ctx-x");
  });

  it("resolves the target with no kubectl on PATH — #231's acceptance criterion", async () => {
    // The npx audience (#193): behold is pointed at a project the operator did
    // not set up, on a machine that has never installed kubectl. PATH is
    // emptied to a directory with nothing in it, so any shell-out that crept
    // back in would fail — and the target still resolves, because reading a
    // kubeconfig was never a job for a binary.
    const emptyBin = join(dir, "empty-bin");
    mkdirSync(emptyBin);
    process.env.PATH = emptyBin;
    process.env.KUBECONFIG = write("eks.yaml", configYaml({ cluster: EKS_CONTEXT, server: "https://localhost:6500", context: EKS_CONTEXT }));

    const kc = await loadKubeconfig();
    expect(resolveK8sTarget({ local: { context: EKS_CONTEXT } }, "local", kc)).toEqual({
      name: "k8s",
      label: EKS_CONTEXT,
      endpoint: "https://localhost:6500",
      source: "profile",
    });
    await expect(ambientContext()).resolves.toBe(EKS_CONTEXT);
  });
});

describe("resolveK8sTarget (#106)", () => {
  const kc = kubeconfigFromView(EKS_VIEW);

  it("resolves the declared profile context to the apiserver the kubeconfig names", () => {
    const t = resolveK8sTarget({ local: { context: EKS_CONTEXT } }, "local", kc);
    expect(t).toEqual({ name: "k8s", label: EKS_CONTEXT, endpoint: "https://localhost:6500", source: "profile" });
  });

  it("reads the port from the kubeconfig rather than assuming one — the acceptance criterion", () => {
    // Floci allocates the apiserver port per cluster, so nothing may hardcode
    // it. Same cluster, different port, and the target follows.
    const moved = kubeconfigFromView({
      contexts: [{ name: EKS_CONTEXT, cluster: EKS_CONTEXT, server: "https://localhost:7311" }],
      currentContext: EKS_CONTEXT,
    });
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
    const bare = kubeconfigFromView({ contexts: [] });
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
