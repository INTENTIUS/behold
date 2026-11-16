import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { kubeTargetFromKubeconfig } from "@intentius/chant/cloud-lister/index";
import { runGraph } from "./graph-cli.ts";
import { runExecPlugin } from "./kube-exec.ts";
import { addOutsideCards, ClusterReadRefusal, drawnIds, kubeconfigPath, readCluster, type ChantLister } from "./read-cluster.ts";

// behold#1083: a cluster drawn from a kubeconfig context. Nothing here needs a
// cluster: the lister is replaced, and the refusals come before it is reached.
// The live read is src/read-cluster-live.test.ts.

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "behold-1083-"));
  made.push(d);
  return d;
};

const kubeconfig = (user: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    apiVersion: "v1",
    kind: "Config",
    "current-context": "gke-prod",
    clusters: [{ name: "prod", cluster: { server: "https://203.0.113.9:443", "insecure-skip-tls-verify": true } }],
    contexts: [{ name: "gke-prod", context: { cluster: "prod", user: "ops" } }],
    users: [{ name: "ops", user }],
    ...extra,
  });

function write(text: string): string {
  const file = join(scratch(), "kubeconfig");
  writeFileSync(file, text);
  return file;
}

/** A lister that counts what reaches it and answers a one-Deployment cluster. */
function fakeChant(): ChantLister & { calls: { index: number; target: unknown[] } } {
  const calls = { index: 0, target: [] as unknown[] };
  const node = (listedType: string, location: string, name: string, attrs: Record<string, unknown> = {}) => ({
    id: `kubernetes/prod/${location}/${encodeURIComponent(listedType)}/${name}`,
    kind: "K8s::X",
    lexicon: "k8s",
    listedType,
    location,
    attrs: { metadata: { name, namespace: location === "cluster" ? undefined : location }, ...attrs },
  });
  return {
    calls,
    kubeTarget: (text, opts) => {
      calls.target.push(JSON.parse(text));
      return { ...kubeTargetFromKubeconfig(text, opts) };
    },
    noneStore: async () => ({ kind: "none" }),
    lexicons: async () => [],
    indexCloud: async () => {
      calls.index++;
      const nodes = [node("apps/v1/Deployment", "shop", "web"), node("v1/Service", "shop", "web"), node("v1/Namespace", "cluster", "shop")];
      return {
        doc: {
          stamp: { observedAt: "2026-01-01T00:00:00.000Z", scope: {} },
          coverage: [{ listedType: "v1/Secret", location: "*", verdict: "no-credentials", detail: "HTTP 403" }],
          notes: [],
          graph: {
            version: 1,
            nodes,
            edges: [
              { from: nodes[1]!.id, to: nodes[0]!.id, kind: "ref", viaAttr: "spec" },
              { from: nodes[0]!.id, to: "kubernetes/prod/shop/not-listed", kind: "ref", viaAttr: "spec" },
            ],
            groups: {},
          } as unknown as GraphIR,
        },
      };
    },
  };
}

describe("readCluster, the credential rule (#1083)", () => {
  it("refuses an exec plugin user, names the context, and lists nothing", async () => {
    const file = write(kubeconfig({ exec: { apiVersion: "client.authentication.k8s.io/v1beta1", command: "gke-gcloud-auth-plugin" } }));
    const chant = fakeChant();
    let ran = 0;
    const err = await readCluster({ kubeconfig: file, chant, runExec: async () => (ran++, { stdout: "" }) }).catch((e) => e);
    expect(err).toBeInstanceOf(ClusterReadRefusal);
    expect(err.code).toBe("exec-plugin");
    expect(err.message).toContain("context gke-prod");
    expect(err.message).toContain("gke-gcloud-auth-plugin");
    expect(err.remedy).toContain("--allow-exec-plugin");
    expect(ran).toBe(0);
    expect(chant.calls.index).toBe(0);
    expect(chant.calls.target).toHaveLength(0);
  });

  it("refuses before chant is loaded, so it holds where chant has no lister", async () => {
    const file = write(kubeconfig({ exec: { command: "aws" } }));
    // no `chant` given: the real one is not reached
    await expect(readCluster({ kubeconfig: file })).rejects.toMatchObject({ code: "exec-plugin" });
  });

  it("always refuses an auth-provider user, even with the plugin switch on", async () => {
    const file = write(kubeconfig({ "auth-provider": { name: "gcp" } }));
    const chant = fakeChant();
    const err = await readCluster({ kubeconfig: file, chant, allowExecPlugin: true }).catch((e) => e);
    expect(err.code).toBe("auth-provider");
    expect(err.message).toContain("context gke-prod");
    expect(chant.calls.index).toBe(0);
  });

  it("with the switch on, runs the plugin once and hands the lister the token it printed", async () => {
    const file = write(kubeconfig({ exec: { apiVersion: "client.authentication.k8s.io/v1", command: "aws", args: ["eks", "get-token"], env: [{ name: "AWS_PROFILE", value: "ops" }] } }));
    const chant = fakeChant();
    const seen: { command: string; args: string[]; env: Record<string, string> }[] = [];
    const read = await readCluster({
      kubeconfig: file,
      chant,
      allowExecPlugin: true,
      runExec: async (command, args, env) => {
        seen.push({ command, args, env });
        return { stdout: JSON.stringify({ apiVersion: "client.authentication.k8s.io/v1", kind: "ExecCredential", status: { token: "tok-123" } }) };
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ command: "aws", args: ["eks", "get-token"] });
    expect(seen[0]!.env.AWS_PROFILE).toBe("ops");
    expect(JSON.parse(seen[0]!.env.KUBERNETES_EXEC_INFO!).spec.interactive).toBe(false);
    const handed = chant.calls.target[0] as { users: { user: Record<string, unknown> }[] };
    expect(handed.users[0]!.user).toEqual({ token: "tok-123" });
    expect(read.cluster.context).toBe("gke-prod");
  });

  it("says so when the plugin gives no credential, and lists nothing", async () => {
    const file = write(kubeconfig({ exec: { command: "aws" } }));
    const chant = fakeChant();
    const err = await readCluster({ kubeconfig: file, chant, allowExecPlugin: true, runExec: async () => ({ stdout: "{}" }) }).catch((e) => e);
    expect(err.code).toBe("exec-plugin");
    expect(err.message).toContain("context gke-prod");
    expect(chant.calls.index).toBe(0);
  });

  it("names a context the kubeconfig lacks, and reads no kubeconfig that is not there", async () => {
    const file = write(kubeconfig({ token: "t" }));
    await expect(readCluster({ kubeconfig: file, context: "nope", chant: fakeChant() })).rejects.toMatchObject({ code: "context", message: expect.stringContaining("no context nope") });
    await expect(readCluster({ kubeconfig: join(scratch(), "absent") })).rejects.toMatchObject({ code: "kubeconfig" });
  });
});

describe("runExecPlugin, a real plugin script (#1083)", () => {
  it("runs a command, passes its args and env, and reads a token or a certificate", async () => {
    const dir = scratch();
    const script = join(dir, "plugin.sh");
    writeFileSync(script, `#!/bin/sh\nprintf '{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"token":"%s-%s"}}' "$1" "$WHO"\n`);
    chmodSync(script, 0o755);
    const cred = await runExecPlugin({ command: script, args: ["one"], env: [{ name: "WHO", value: "me" }] }, { server: "https://x" });
    expect(cred).toEqual({ token: "one-me" });

    const cert = join(dir, "cert.sh");
    writeFileSync(cert, `#!/bin/sh\nprintf '{"kind":"ExecCredential","status":{"clientCertificateData":"CERT","clientKeyData":"KEY"}}'\n`);
    chmodSync(cert, 0o755);
    expect(await runExecPlugin({ command: "./cert.sh" }, { server: "https://x" }, { baseDir: dir })).toEqual({ clientCertificateData: "CERT", clientKeyData: "KEY" });
  });

  it("reports a plugin that fails, and one that prints nothing usable", async () => {
    const dir = scratch();
    const bad = join(dir, "bad.sh");
    writeFileSync(bad, "#!/bin/sh\necho nope >&2\nexit 3\n");
    chmodSync(bad, 0o755);
    await expect(runExecPlugin({ command: bad }, { server: "https://x" })).rejects.toThrow(/nope/);
    const junk = join(dir, "junk.sh");
    writeFileSync(junk, "#!/bin/sh\necho hello\n");
    chmodSync(junk, 0o755);
    await expect(runExecPlugin({ command: junk }, { server: "https://x" })).rejects.toThrow(/no ExecCredential/);
  });
});

describe("readCluster, the drawing (#1083)", () => {
  it("boxes cards by namespace, names ids by namespace, kind and name, and drops edges to unlisted objects", async () => {
    const file = write(kubeconfig({ token: "t" }));
    const read = await readCluster({ kubeconfig: file, chant: fakeChant() });
    expect(read.ir.nodes.map((n) => n.id).sort()).toEqual(["cluster/Namespace/shop", "shop/Deployment/web", "shop/Service/web"]);
    expect(read.ir.edges.map((e) => `${e.from} -> ${e.to}`)).toEqual(["shop/Service/web -> shop/Deployment/web"]);
    expect((read.ir.groups as { byStack: Record<string, string[]> }).byStack).toEqual({ shop: ["shop/Deployment/web", "shop/Service/web"], cluster: ["cluster/Namespace/shop"] });
    expect(read.members).toEqual([{ name: "gke-prod", dir: "", kind: "chant" }]);
    expect(read.meta.note).toContain("read from cluster gke-prod, 3 objects");
    expect(read.meta.note).toContain("1 kinds not listed (no-credentials)");
    expect(read.meta.note).toContain("1 edges to objects outside the read are left out");
  });

  it("keeps the API group in the id when two kinds share a name", () => {
    const ids = drawnIds([
      { id: "a", listedType: "networking.k8s.io/v1/Ingress", location: "app", attrs: { metadata: { name: "web" } } },
      { id: "b", listedType: "extensions/v1beta1/Ingress", location: "app", attrs: { metadata: { name: "web" } } },
      { id: "c", listedType: "v1/Service", location: "app", attrs: { metadata: { name: "web" } } },
    ]);
    expect([...ids.values()]).toEqual(["app/networking.k8s.io/Ingress/web", "app/extensions/Ingress/web", "app/Service/web"]);
  });

  it("reads the kubeconfig from --kubeconfig, then KUBECONFIG's first path, then the home directory", () => {
    expect(kubeconfigPath({ kubeconfig: "/a/b" })).toBe("/a/b");
    expect(kubeconfigPath({ env: { KUBECONFIG: "/x/one:/x/two" } })).toBe("/x/one");
    expect(kubeconfigPath({ env: {}, home: "/home/u" })).toBe("/home/u/.kube/config");
  });
});

describe("readCluster, placeholder cards (#1082 over a live read)", () => {
  const listed = (listedType: string, location: string, name: string, attrs: Record<string, unknown>) => ({
    id: `${location}/${name}`,
    kind: `K8s::${listedType.split("/").pop()}`,
    lexicon: "k8s",
    listedType,
    location,
    attrs: { metadata: { name, namespace: location }, ...attrs },
  });
  const ir = (nodes: unknown[]) => ({ version: 1, nodes, edges: [], groups: { byStack: {} } }) as unknown as GraphIR;

  it("draws a cloud identity from a ServiceAccount annotation, in a box of its own", () => {
    const sa = listed("v1/ServiceAccount", "app", "runner", { metadata: { name: "runner", namespace: "app", annotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::111122223333:role/ci" } } });
    const out = addOutsideCards(ir([sa]));
    expect(out.cards).toBe(1);
    expect(out.ir.nodes.map((n) => n.id)).toContain("outside:identity:aws:arn:aws:iam::111122223333:role/ci");
    expect(out.ir.edges).toEqual([expect.objectContaining({ from: "app/runner", to: "outside:identity:aws:arn:aws:iam::111122223333:role/ci" })]);
    expect((out.ir.groups as { byStack: Record<string, string[]> }).byStack["Outside the cluster"]).toHaveLength(1);
  });

  it("counts a reference field the live read masked, whichever mark it wears", () => {
    for (const mark of ["<masked>", "[REDACTED]"]) {
      const es = listed("external-secrets.io/v1/ExternalSecret", "app", "creds", { spec: { secretStoreRef: mark } });
      expect(addOutsideCards(ir([es])).masked).toBe(1);
    }
  });

  it("draws the store's provider when the reference is readable, which is what chant#5116 allows", () => {
    const es = listed("external-secrets.io/v1/ExternalSecret", "app", "creds", { spec: { secretStoreRef: { name: "gcp", kind: "ClusterSecretStore" }, data: [{ remoteRef: { key: "k" } }] } });
    const store = listed("external-secrets.io/v1/ClusterSecretStore", "", "gcp", { spec: { provider: { gcpsm: { projectID: "demo" } } } });
    const out = addOutsideCards(ir([es, store]));
    expect(out.masked).toBe(0);
    expect(out.ir.nodes.map((n) => n.id)).toContain("outside:provider:gcpsm:demo");
  });
});

describe("behold graph --context, arguments and refusals (#1083)", () => {
  const run = async (argv: string[]) => {
    let out = "";
    let err = "";
    const code = await runGraph(argv, { version: "0.0.0-test", stdout: (t) => void (out += String(t)), stderr: (t) => void (err += t) });
    return { code, out, err };
  };

  it("refuses an exec plugin kubeconfig: exit 2, the context named, nothing printed, no store written", async () => {
    const file = write(kubeconfig({ exec: { command: "aws" } }));
    const store = scratch();
    const was = { XDG: process.env.XDG_DATA_HOME, IDX: process.env.BEHOLD_INDEX_DIR };
    process.env.XDG_DATA_HOME = store;
    delete process.env.BEHOLD_INDEX_DIR;
    try {
      const r = await run(["--kubeconfig", file, "--context", "gke-prod", "--json"]);
      expect(r.code).toBe(2);
      expect(r.out).toBe("");
      expect(r.err).toContain("context gke-prod");
      expect(r.err).toContain("exec plugin");
      expect(r.err).toContain("--allow-exec-plugin");
      expect(r.err).toContain("Nothing was listed");
      expect(readdirSync(store)).toEqual([]);
    } finally {
      if (was.XDG === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = was.XDG;
      if (was.IDX !== undefined) process.env.BEHOLD_INDEX_DIR = was.IDX;
    }
  });

  it("takes a cluster or a directory, not both, and the cluster flags only with a cluster", async () => {
    expect((await run(["somedir", "--context", "x"])).err).toContain("two reads");
    expect((await run(["--context", "x", "--changed", "a..b"])).err).toContain("does not go with --context");
    expect((await run(["--namespace", "a"])).err).toContain("go with --context");
    expect((await run(["--allow-exec-plugin"])).code).toBe(2);
    expect((await run(["--context"])).code).toBe(2);
  });
});

describe("readCluster, owner and selector edges (#1114)", () => {
  const obj = (listedType: string, name: string, uid: string, metadata: Record<string, unknown>, spec: Record<string, unknown> = {}) => ({
    id: `kubernetes/prod/app/${encodeURIComponent(listedType)}/${name}`,
    kind: `K8s::${{ Deployment: "Apps", ReplicaSet: "Apps", Pod: "Core", Service: "Core", EndpointSlice: "Discovery" }[listedType.split("/").pop()!]}::${listedType.split("/").pop()}`,
    lexicon: "k8s",
    listedType,
    location: "app",
    facts: { cloudIds: [{ kind: "k8s-uid", value: uid }] },
    attrs: { metadata: { name, namespace: "app", ...metadata }, spec },
  });
  const owner = (kind: string, name: string, uid: string) => ({ ownerReferences: [{ apiVersion: "apps/v1", kind, name, uid, controller: true }] });

  it("draws Pod to ReplicaSet to Deployment, the Service to its Pods and the EndpointSlice to the Service", async () => {
    const nodes = [
      obj("apps/v1/Deployment", "web", "u1", {}),
      obj("apps/v1/ReplicaSet", "web-1", "u2", owner("Deployment", "web", "u1")),
      obj("v1/Pod", "web-1-a", "u3", { ...owner("ReplicaSet", "web-1", "u2"), labels: { app: "web" } }),
      obj("v1/Pod", "web-1-b", "u4", { ...owner("ReplicaSet", "web-1", "u2"), labels: { app: "web" } }),
      obj("v1/Service", "web", "u5", {}, { selector: { app: "web" } }),
      obj("discovery.k8s.io/v1/EndpointSlice", "web-xyz", "u6", { labels: { "kubernetes.io/service-name": "web" } }),
    ];
    const base = fakeChant();
    const chant: ChantLister = {
      ...base,
      indexCloud: async () => ({
        doc: { stamp: { observedAt: "2026-01-01T00:00:00.000Z", scope: {} }, coverage: [], notes: [], graph: { version: 1, nodes, edges: [], groups: {} } as unknown as GraphIR },
      }),
    };
    const read = await readCluster({ kubeconfig: write(kubeconfig({ token: "t" })), chant });
    const edges = new Set(read.ir.edges.map((e) => `${e.from} -> ${e.to}`));
    for (const e of [
      "app/ReplicaSet/web-1 -> app/Deployment/web",
      "app/Pod/web-1-a -> app/ReplicaSet/web-1",
      "app/Pod/web-1-b -> app/ReplicaSet/web-1",
      "app/Service/web -> app/Pod/web-1-a",
      "app/Service/web -> app/Pod/web-1-b",
      "app/EndpointSlice/web-xyz -> app/Service/web",
    ]) expect(edges).toContain(e);
    // One edge per pair, however many passes found it.
    expect(read.ir.edges.length).toBe(edges.size);
  });
});
