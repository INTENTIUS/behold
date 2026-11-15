/**
 * behold#1083, on a scratch k3d cluster this test creates: `behold graph` over
 * a kubeconfig context draws a Deployment, a Service and a ServiceAccount and
 * the Service-to-Deployment edge, writes nothing to the index store, refuses an
 * exec plugin user until told to run it, and says what a live read does to an
 * ExternalSecret's reference and to an Argo CD cluster Secret (chant#5116).
 *
 * Opt in with BEHOLD_K3D_TESTS=1 (needs docker, k3d and kubectl). The cluster is
 * named by src/scratch.ts's rules, refused if the name is taken, and deleted in
 * afterAll by name, only if this run created it, unless BEHOLD_K3D_KEEP=1, which
 * leaves it and logs its name. BEHOLD_EXPECT_5116=1 makes the test that waits on
 * chant#5116 fail instead of skip, for a chant that carries it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGraph } from "./graph-cli.ts";
import { assertScratch } from "./scratch.ts";

const has = (bin: string, ...args: string[]) => spawnSync(bin, args.length ? args : ["--version"], { encoding: "utf8" }).status === 0;
const enabled = process.env.BEHOLD_K3D_TESTS === "1" && has("k3d") && has("kubectl", "version", "--client") && has("docker");
const keep = process.env.BEHOLD_K3D_KEEP === "1";

const CLUSTER = `behold-read-cluster-${process.pid}`;
const CONTEXT = `k3d-${CLUSTER}`;

const crd = (group: string, kind: string, plural: string, scope: "Namespaced" | "Cluster") => ({
  apiVersion: "apiextensions.k8s.io/v1",
  kind: "CustomResourceDefinition",
  metadata: { name: `${plural}.${group}` },
  spec: {
    group,
    scope,
    names: { kind, plural, singular: kind.toLowerCase() },
    versions: [{ name: "v1", served: true, storage: true, schema: { openAPIV3Schema: { type: "object", "x-kubernetes-preserve-unknown-fields": true } } }],
  },
});
const CRDS = [crd("external-secrets.io", "ExternalSecret", "externalsecrets", "Namespaced"), crd("external-secrets.io", "ClusterSecretStore", "clustersecretstores", "Cluster")];

const NAMESPACES = ["shop", "argocd"].map((name) => ({ apiVersion: "v1", kind: "Namespace", metadata: { name } }));
const OBJECTS = [
  { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "web", namespace: "shop" } },
  {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace: "shop" },
    spec: { replicas: 0, selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } }, spec: { serviceAccountName: "web", containers: [{ name: "web", image: "nginx:1.27" }] } } },
  },
  { apiVersion: "v1", kind: "Service", metadata: { name: "web", namespace: "shop" }, spec: { selector: { app: "web" }, ports: [{ port: 80 }] } },
  { apiVersion: "external-secrets.io/v1", kind: "ClusterSecretStore", metadata: { name: "gcp" }, spec: { provider: { gcpsm: { projectID: "demo-proj" } } } },
  {
    apiVersion: "external-secrets.io/v1",
    kind: "ExternalSecret",
    metadata: { name: "web-creds", namespace: "shop" },
    spec: { secretStoreRef: { name: "gcp", kind: "ClusterSecretStore" }, data: [{ secretKey: "token", remoteRef: { key: "web-token" } }] },
  },
  {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "cluster-prod", namespace: "argocd", labels: { "argocd.argoproj.io/secret-type": "cluster" } },
    stringData: { name: "prod", server: "https://prod.example.com", config: '{"bearerToken":"hunter2"}' },
  },
];

describe.skipIf(!enabled)("behold graph --context over a live cluster (scratch k3d)", () => {
  let dir = "";
  let kubeconfig = "";
  let execKubeconfig = "";
  let created = false;

  const run = (cmd: string, args: string[], input?: string, timeout = 120_000) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", input, timeout });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    return r.stdout;
  };
  const kubectl = (args: string[], input?: string) => run("kubectl", ["--kubeconfig", kubeconfig, ...args], input);
  const list = (items: unknown[]) => JSON.stringify({ apiVersion: "v1", kind: "List", items });

  async function graph(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const code = await runGraph(argv, { version: "0.0.0-test", stdout: (t) => void (out += String(t)), stderr: (t) => void (err += t) });
    return { code, out, err };
  }
  const json = async (argv: string[]) => {
    const r = await graph([...argv, "--json"]);
    if (r.code !== 0) throw new Error(`behold graph exited ${r.code}: ${r.err}`);
    return JSON.parse(r.out) as { nodes: { id: string; attrs?: Record<string, any> }[]; edges: { source: string; target: string }[]; notes: { text: string }[] };
  };

  beforeAll(() => {
    assertScratch(CLUSTER);
    if (run("k3d", ["cluster", "list", "-o", "json"]).includes(`"name":"${CLUSTER}"`)) {
      throw new Error(`k3d cluster ${CLUSTER} already exists; remove it yourself (k3d cluster delete ${CLUSTER}) and re-run`);
    }
    dir = mkdtempSync(join(tmpdir(), "behold-read-cluster-"));
    kubeconfig = join(dir, "kubeconfig");
    run("k3d", ["cluster", "create", CLUSTER, "--wait", "--no-lb", "--kubeconfig-update-default=false", "--kubeconfig-switch-context=false"], undefined, 300_000);
    created = true;
    if (keep) process.stderr.write(`behold-1083: scratch cluster ${CLUSTER} left running (BEHOLD_K3D_KEEP=1)\n`);
    writeFileSync(kubeconfig, run("k3d", ["kubeconfig", "get", CLUSTER]));
    kubectl(["apply", "-f", "-"], list(CRDS));
    for (const c of CRDS) kubectl(["wait", "--for=condition=established", `crd/${c.metadata.name}`, "--timeout=60s"]);
    kubectl(["apply", "-f", "-"], list(NAMESPACES));
    kubectl(["apply", "-f", "-"], list(OBJECTS));

    // The same cluster through an exec plugin: k3d's client certificate, printed as an ExecCredential.
    const cfg = JSON.parse(run("kubectl", ["--kubeconfig", kubeconfig, "config", "view", "--raw", "-o", "json"])) as { users: { name: string; user: Record<string, string> }[]; contexts: { name: string }[]; clusters: unknown[] };
    const u = cfg.users[0]!.user;
    const status = { clientCertificateData: Buffer.from(u["client-certificate-data"]!, "base64").toString("utf8"), clientKeyData: Buffer.from(u["client-key-data"]!, "base64").toString("utf8") };
    writeFileSync(join(dir, "credential.json"), JSON.stringify({ apiVersion: "client.authentication.k8s.io/v1", kind: "ExecCredential", status }));
    const plugin = join(dir, "plugin.sh");
    writeFileSync(plugin, `#!/bin/sh\ncat "${join(dir, "credential.json")}"\n`);
    chmodSync(plugin, 0o755);
    cfg.users[0]!.user = { exec: { apiVersion: "client.authentication.k8s.io/v1", command: plugin, interactiveMode: "Never" } } as never;
    execKubeconfig = join(dir, "kubeconfig-exec");
    writeFileSync(execKubeconfig, JSON.stringify(cfg));
  }, 420_000);

  afterAll(() => {
    if (created && !keep) {
      assertScratch(CLUSTER);
      spawnSync("k3d", ["cluster", "delete", CLUSTER], { encoding: "utf8", timeout: 120_000 });
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  it("prints the Deployment, Service and ServiceAccount and the Service-to-Deployment edge", async () => {
    const doc = await json(["--kubeconfig", kubeconfig, "--context", CONTEXT]);
    const ids = doc.nodes.map((n) => n.id);
    for (const id of ["shop/Deployment/web", "shop/Service/web", "shop/ServiceAccount/web"]) expect(ids).toContain(id);
    expect(doc.edges).toContainEqual(expect.objectContaining({ source: "shop/Service/web", target: "shop/Deployment/web" }));
    expect(doc.notes.map((n) => n.text).join(" ")).toContain(`read from cluster ${CONTEXT}`);
  });

  it("writes nothing: the index store directories and the working directory's store are unchanged", async () => {
    const store = mkdtempSync(join(tmpdir(), "behold-read-cluster-store-"));
    const here = join(process.cwd(), ".chant");
    const before = existsSync(here) ? statSync(here).mtimeMs : null;
    const was = { XDG: process.env.XDG_DATA_HOME, B: process.env.BEHOLD_INDEX_DIR, C: process.env.CHANT_INDEX_DIR };
    process.env.XDG_DATA_HOME = store;
    process.env.BEHOLD_INDEX_DIR = join(store, "behold", "index");
    process.env.CHANT_INDEX_DIR = join(store, "chant", "index");
    try {
      await json(["--kubeconfig", kubeconfig, "--context", CONTEXT, "--namespace", "shop"]);
      expect(readdirSync(store)).toEqual([]);
      expect(existsSync(here) ? statSync(here).mtimeMs : null).toBe(before);
    } finally {
      for (const [k, v] of [["XDG_DATA_HOME", was.XDG], ["BEHOLD_INDEX_DIR", was.B], ["CHANT_INDEX_DIR", was.C]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("refuses the exec plugin kubeconfig, then reads the same cluster once told to run it", async () => {
    const refused = await graph(["--kubeconfig", execKubeconfig, "--context", CONTEXT, "--json"]);
    expect(refused.code).toBe(2);
    expect(refused.out).toBe("");
    expect(refused.err).toContain(`context ${CONTEXT}`);
    const doc = await json(["--kubeconfig", execKubeconfig, "--context", CONTEXT, "--allow-exec-plugin", "--namespace", "shop"]);
    expect(doc.nodes.map((n) => n.id)).toContain("shop/Deployment/web");
  });

  // What the live read does to a reference field is chant#5116's to decide, and
  // behold draws whichever answer the chant beside it gives.
  const secretStoreRef = async () => {
    const doc = await json(["--kubeconfig", kubeconfig, "--context", CONTEXT, "--namespace", "shop,cluster"]);
    const es = doc.nodes.find((n) => n.id === "shop/ExternalSecret/web-creds");
    expect(es).toBeDefined();
    return { doc, ref: es!.attrs?.spec?.secretStoreRef };
  };

  it("keeps spec.secretStoreRef.name readable on the ExternalSecret (waits on chant#5116)", async (ctx) => {
    const { doc, ref } = await secretStoreRef();
    if (ref?.name === undefined && process.env.BEHOLD_EXPECT_5116 !== "1") ctx.skip();
    expect(ref).toMatchObject({ name: "gcp", kind: "ClusterSecretStore" });
    // readable, so the provider card is drawn
    expect(doc.nodes.map((n) => n.id)).toContain("outside:provider:gcpsm:demo-proj");
  });

  it("says the reference is masked while the chant beside behold masks it", async (ctx) => {
    const { doc, ref } = await secretStoreRef();
    if (ref?.name !== undefined) ctx.skip();
    expect(typeof ref).toBe("string");
    expect(doc.notes.map((n) => n.text).join(" ")).toContain("chant#5116");
    expect(doc.nodes.some((n) => n.id.startsWith("outside:store:"))).toBe(false);
  });

  it("never shows the Argo CD cluster Secret's config, whether or not its name and server show (chant#5116)", async () => {
    const r = await graph(["--kubeconfig", kubeconfig, "--context", CONTEXT, "--namespace", "argocd", "--json", "--source"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("cluster-prod");
    expect(r.out).not.toContain("hunter2");
    expect(r.out).not.toContain("bearerToken");
  });
});
