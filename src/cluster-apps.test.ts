import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";
import { kubeTargetFromKubeconfig } from "@intentius/chant/cloud-lister/index";
import { relationOf, type InferApps, type InferredApps } from "./cluster-apps.ts";
import type { GraphDocument } from "./graph-document.ts";
import { runGraph } from "./graph-cli.ts";
import { clusterCaption } from "./graph-view.ts";
import { k8sIconFor } from "./icon-packs.ts";
import { outsideFields, workloadFields } from "./operator-cards.ts";
import { outsideTitle, type ChantLister } from "./read-cluster.ts";

// behold#1132: an operator's view of a cluster read. The lister and chant's
// inference are replaced, so nothing here needs a cluster or a chant that
// infers applications; the last test runs chant's own inference when the
// chant beside behold has it.

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function kubeconfigFile(): string {
  const d = mkdtempSync(join(tmpdir(), "behold-1132-"));
  made.push(d);
  const file = join(d, "kubeconfig");
  writeFileSync(
    file,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      "current-context": "k3d-shop",
      clusters: [{ name: "shop", cluster: { server: "https://203.0.113.9:443", "insecure-skip-tls-verify": true } }],
      contexts: [{ name: "k3d-shop", context: { cluster: "shop", user: "ops" } }],
      users: [{ name: "ops", user: { token: "t" } }],
    }),
  );
  return file;
}

const KIND: Record<string, string> = {
  "apps/v1/Deployment": "K8s::Apps::Deployment",
  "apps/v1/ReplicaSet": "K8s::Apps::ReplicaSet",
  "v1/Pod": "K8s::Core::Pod",
  "v1/Service": "K8s::Core::Service",
  "v1/ConfigMap": "K8s::Core::ConfigMap",
  "v1/Secret": "K8s::Core::Secret",
  "v1/ServiceAccount": "K8s::Core::ServiceAccount",
  "discovery.k8s.io/v1/EndpointSlice": "K8s::Discovery::EndpointSlice",
};
const lid = (listedType: string, name: string) => `kubernetes/shop/shop/${encodeURIComponent(listedType)}/${name}`;
const node = (listedType: string, name: string, attrs: Record<string, unknown> = {}): IRNode =>
  ({
    id: lid(listedType, name),
    kind: KIND[listedType],
    lexicon: "k8s",
    listedType,
    location: "shop",
    nativeId: `shop/${name}`,
    attrs: { ...attrs, metadata: { name, namespace: "shop", ...((attrs.metadata as object) ?? {}) } },
  }) as unknown as IRNode;
const owner = (kind: string, name: string) => ({ metadata: { ownerReferences: [{ kind, name, controller: true }] } });
const template = (app: string, spec: Record<string, unknown>) => ({ spec: { replicas: 2, selector: { matchLabels: { app } }, template: { metadata: { labels: { app } }, spec } } });
const checkoutSpec = {
  serviceAccountName: "checkout",
  containers: [{ name: "web", image: "nginx:1.27-alpine", envFrom: [{ configMapRef: { name: "checkout-config" } }] }],
  volumes: [{ name: "tls", secret: { secretName: "checkout-tls" } }],
};

const D = "apps/v1/Deployment";
const RS = "apps/v1/ReplicaSet";
const POD = "v1/Pod";
const SVC = "v1/Service";
const CM = "v1/ConfigMap";
const SEC = "v1/Secret";
const SA = "v1/ServiceAccount";
const ES = "discovery.k8s.io/v1/EndpointSlice";

/** The scratch cluster of #1132: checkout (two replicas, a Service, its config, a mounted Secret, an IRSA ServiceAccount) and payments. */
function listed(): GraphIR {
  const nodes = [
    node(D, "checkout", { ...template("checkout", checkoutSpec), workloadStatus: { desiredReplicas: 2, readyReplicas: 1 } }),
    node(RS, "checkout-6d4f", { ...owner("Deployment", "checkout"), ...template("checkout", checkoutSpec) }),
    node(POD, "checkout-6d4f-a1", { metadata: { ...owner("ReplicaSet", "checkout-6d4f").metadata, labels: { app: "checkout" } }, spec: checkoutSpec, workloadStatus: { restarts: 1 } }),
    node(POD, "checkout-6d4f-b2", { metadata: { ...owner("ReplicaSet", "checkout-6d4f").metadata, labels: { app: "checkout" } }, spec: checkoutSpec, workloadStatus: { restarts: 2 } }),
    node(SVC, "checkout", { spec: { selector: { app: "checkout" }, ports: [{ port: 80, targetPort: 8080 }] } }),
    node(ES, "checkout-x9", { metadata: { labels: { "kubernetes.io/service-name": "checkout" } } }),
    node(CM, "checkout-config", { data: { PAYMENTS_URL: "http://payments.shop.svc" } }),
    node(SEC, "checkout-tls"),
    node(SA, "checkout", { metadata: { annotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::123456789012:role/shop-checkout-runtime" } } }),
    node(CM, "kube-root-ca.crt"),
    node(SA, "default"),
    node(D, "payments", { ...template("payments", { containers: [{ name: "api", image: "nginx:1.27-alpine" }] }), workloadStatus: { desiredReplicas: 1, readyReplicas: 1 } }),
    node(SVC, "payments", { spec: { selector: { app: "payments" }, ports: [{ port: 80 }] } }),
  ];
  const ref = (fromType: string, from: string, toType: string, to: string, path: string): IREdge =>
    ({ from: lid(fromType, from), to: lid(toType, to), kind: "ref", origin: "derived", rule: `k8s:${KIND[fromType]}:${path}`, viaAttr: path.split(".")[0] }) as unknown as IREdge;
  const tpl = "spec.template.spec.";
  const edges = [
    ref(SVC, "checkout", D, "checkout", "spec.selector.app"),
    ref(SVC, "payments", D, "payments", "spec.selector.app"),
    ref(D, "checkout", CM, "checkout-config", `${tpl}containers[].envFrom[].configMapRef.name`),
    ref(D, "checkout", SEC, "checkout-tls", `${tpl}volumes[].secret.secretName`),
    ref(D, "checkout", SA, "checkout", `${tpl}serviceAccountName`),
    ref(RS, "checkout-6d4f", D, "checkout", "metadata.ownerReferences[].name"),
    ref(RS, "checkout-6d4f", CM, "checkout-config", `${tpl}containers[].envFrom[].configMapRef.name`),
    ref(RS, "checkout-6d4f", SEC, "checkout-tls", `${tpl}volumes[].secret.secretName`),
    ref(RS, "checkout-6d4f", SA, "checkout", `${tpl}serviceAccountName`),
    ...["checkout-6d4f-a1", "checkout-6d4f-b2"].flatMap((p) => [
      ref(POD, p, RS, "checkout-6d4f", "metadata.ownerReferences[].name"),
      ref(POD, p, CM, "checkout-config", "spec.containers[].envFrom[].configMapRef.name"),
      ref(POD, p, SEC, "checkout-tls", "spec.volumes[].secret.secretName"),
      ref(POD, p, SA, "checkout", "spec.serviceAccountName"),
      ref(POD, p, CM, "kube-root-ca.crt", "spec.volumes[].projected.sources[].configMap.name"),
    ]),
    { from: lid(ES, "checkout-x9"), to: lid(SVC, "checkout"), kind: "ref", origin: "derived", rule: "identity-match:k8s:K8s::Core::Service:k8s-uid", viaAttr: "metadata" } as unknown as IREdge,
    { from: lid(ES, "checkout-x9"), to: lid(POD, "checkout-6d4f-a1"), kind: "ref", origin: "derived", rule: "identity-match:k8s:K8s::Core::Pod:k8s-uid", viaAttr: "endpoints" } as unknown as IREdge,
  ];
  return { version: 1, nodes, edges, groups: {} } as unknown as GraphIR;
}

/** What chant's inference answers for {@link listed}, in the lister's ids. */
const inferred: InferredApps = {
  ir: {
    version: 1,
    nodes: [
      {
        id: "payments",
        kind: "Component",
        lexicon: "chant",
        attrs: { wave: 1, namespace: "shop", inferredFrom: "kubernetes", status: { readyReplicas: 1, desiredReplicas: 1, restarts: 0 }, members: [{ id: lid(D, "payments"), role: "workload" }, { id: lid(SVC, "payments"), role: "service" }] },
      },
      {
        id: "checkout",
        kind: "Component",
        lexicon: "chant",
        attrs: {
          wave: 2,
          namespace: "shop",
          inferredFrom: "kubernetes",
          status: { readyReplicas: 1, desiredReplicas: 2, restarts: 3 },
          members: [
            { id: lid(D, "checkout"), role: "workload" },
            { id: lid(RS, "checkout-6d4f"), role: "runtime" },
            { id: lid(POD, "checkout-6d4f-a1"), role: "runtime" },
            { id: lid(POD, "checkout-6d4f-b2"), role: "runtime" },
            { id: lid(SVC, "checkout"), role: "service" },
            { id: lid(ES, "checkout-x9"), role: "bookkeeping" },
            { id: lid(CM, "checkout-config"), role: "config" },
            { id: lid(SEC, "checkout-tls"), role: "config" },
            { id: lid(SA, "checkout"), role: "identity" },
            { id: lid(CM, "kube-root-ca.crt"), role: "bookkeeping" },
          ],
          liveNames: [lid(D, "checkout")],
        },
      },
    ] as unknown as IRNode[],
    edges: [{ from: "checkout", to: "payments", kind: "ref", origin: "derived", rule: "k8s:service-dns", viaAttr: "ConfigMap checkout-config data.PAYMENTS_URL" } as unknown as IREdge],
    groups: { byWave: { "wave-1": ["payments"], "wave-2": ["checkout"] } },
  } as unknown as GraphIR,
  shared: [{ id: lid(SA, "default"), role: "bookkeeping", usedBy: ["payments", "other"] }],
  notes: [],
};

function fakeChant(inferApps?: InferApps): ChantLister {
  return {
    kubeTarget: (text, opts) => kubeTargetFromKubeconfig(text, opts),
    noneStore: async () => ({ kind: "none" }),
    lexicons: async () => [],
    indexCloud: async () => ({ doc: { stamp: { observedAt: "2026-11-16T00:00:00.000Z", scope: {} }, coverage: [], notes: [], graph: listed() } }),
    ...(inferApps ? { inferApps } : {}),
  };
}

async function graph(argv: string[], chant: ChantLister): Promise<{ code: number; doc?: GraphDocument; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runGraph(["--kubeconfig", kubeconfigFile(), ...argv], { version: "0.0.0-test", chant, stdout: (t) => void (out += String(t)), stderr: (t) => void (err += t) });
  const doc = code === 0 && argv.every((a) => a !== "--svg") ? (JSON.parse(out) as GraphDocument) : undefined;
  return { code, out, err, ...(doc ? { doc } : {}) };
}

const edgesOf = (doc: GraphDocument) => doc.edges.map((e) => `${e.source} ${e.via} ${e.target}`).sort();
const ROLE = "outside:identity:aws:arn:aws:iam::123456789012:role/shop-checkout-runtime";

describe("the objects view of a cluster read (#1132)", () => {
  it("folds the runtime and bookkeeping objects and labels each edge with its relationship", async () => {
    const { doc } = await graph(["--around", "shop/Deployment/checkout", "--depth", "2"], fakeChant(() => inferred));
    expect(doc!.nodes.map((n) => n.id).sort()).toEqual([ROLE, "shop/ConfigMap/checkout-config", "shop/Deployment/checkout", "shop/Secret/checkout-tls", "shop/Service/checkout", "shop/ServiceAccount/checkout"].sort());
    expect(edgesOf(doc!)).toEqual(
      [
        "shop/Deployment/checkout mounts shop/Secret/checkout-tls",
        "shop/Deployment/checkout reads env from shop/ConfigMap/checkout-config",
        "shop/Deployment/checkout runs as shop/ServiceAccount/checkout",
        "shop/Service/checkout routes to :80 to 8080 shop/Deployment/checkout",
        `shop/ServiceAccount/checkout assumes role ${ROLE}`,
      ].sort(),
    );
    // The field the reference was found in stays on the edge.
    expect(doc!.edges.find((e) => e.via === "runs as")?.field).toBe("spec.template.spec.serviceAccountName");
  });

  it("puts health, image and restarts on the workload card, and the Pods' names off its face", async () => {
    const { doc } = await graph([], fakeChant(() => inferred));
    const w = doc!.nodes.find((n) => n.id === "shop/Deployment/checkout")!;
    expect(w.title).toBe("checkout");
    expect(w.status).toBe("warn");
    expect(w.attrs._workload).toEqual({ ready: 1, desired: 2, image: "nginx:1.27-alpine", restarts: 3, pods: ["checkout-6d4f-a1", "checkout-6d4f-b2"] });
    expect(w.attrs._folded).toEqual(expect.arrayContaining(["shop/ReplicaSet/checkout-6d4f", "shop/Pod/checkout-6d4f-a1", "shop/ConfigMap/kube-root-ca.crt"]));
    expect(workloadFields(w.attrs)).toEqual([
      { label: "ready", value: "1/2" },
      { label: "image", value: "nginx:1.27-alpine" },
      { label: "restarts", value: "3" },
    ]);
    const ids = doc!.nodes.map((n) => n.id);
    for (const gone of ["shop/EndpointSlice/checkout-x9", "shop/ServiceAccount/default", "shop/ConfigMap/kube-root-ca.crt"]) expect(ids).not.toContain(gone);
    expect(doc!.notes[0]!.text).toContain("folded into the card they serve (--every-card draws them)");
  });

  it("draws every card with --every-card, each pod template reference still once, from the workload", async () => {
    const { doc } = await graph(["--every-card"], fakeChant(() => inferred));
    const ids = doc!.nodes.map((n) => n.id);
    expect(ids).toContain("shop/ReplicaSet/checkout-6d4f");
    expect(ids).toContain("shop/Pod/checkout-6d4f-a1");
    expect(ids).toContain("shop/EndpointSlice/checkout-x9");
    const toConfig = doc!.edges.filter((e) => e.target === "shop/ConfigMap/checkout-config").map((e) => e.source);
    expect(toConfig).toEqual(["shop/Deployment/checkout"]);
    expect(doc!.edges.filter((e) => e.via === "owned by")).toHaveLength(3);
    expect(doc!.notes[0]!.text).toContain("pod template references are drawn once, from the workload");
  });

  it("still labels and folds by kind when the chant beside behold infers no applications", async () => {
    const { doc } = await graph([], fakeChant());
    expect(doc!.edges.find((e) => e.source === "shop/Deployment/checkout" && e.target === "shop/ServiceAccount/checkout")?.via).toBe("runs as");
    expect(doc!.nodes.map((n) => n.id)).not.toContain("shop/EndpointSlice/checkout-x9");
  });
});

describe("the logical view of a cluster read (#1132)", () => {
  it("boxes the application with what it manages and what that names outside the cluster", async () => {
    const { doc } = await graph(["--logical", "--around", "shop/Deployment/checkout", "--depth", "2"], fakeChant(() => inferred));
    // Two hops out from the workload reach payments' Service, through the dependsOn the ConfigMap holds.
    expect(doc!.nodes).toHaveLength(7);
    expect(doc!.edges).toHaveLength(6);
    expect(doc!.edges.every((e) => ["routes to :80 to 8080", "runs as", "reads env from", "mounts", "assumes role", "depends on: PAYMENTS_URL"].includes(e.via!))).toBe(true);
    expect(doc!.nodes.find((n) => n.id === "shop/Service/checkout")?.box).toBe("stack:checkout");
    expect(doc!.nodes.find((n) => n.id === "shop/Service/payments")?.box).toBe("stack:payments");
    expect(doc!.nodes.find((n) => n.id === ROLE)?.box).toBe("stack:Outside the cluster");
  });

  it("titles each application's box with its health, and draws dependsOn between the boxes", async () => {
    const { doc } = await graph(["--logical"], fakeChant(() => inferred));
    expect(doc!.groups.filter((g) => g.kind === "stack").map((g) => g.title)).toEqual(expect.arrayContaining(["checkout · 1/2 ready", "payments · 1/1 ready"]));
    expect(doc!.edges).toContainEqual(
      expect.objectContaining({ source: "shop/ConfigMap/checkout-config", target: "shop/Service/payments", via: "depends on: PAYMENTS_URL", field: "ConfigMap checkout-config data.PAYMENTS_URL" }),
    );
    const { out } = await graph(["--logical", "--svg"], fakeChant(() => inferred));
    expect(out).toContain(">checkout · 1/2 ready<");
    expect(out).not.toContain("all managed");
  });

  it("is empty, and says why, when the chant beside behold infers no applications", async () => {
    const { doc } = await graph(["--logical"], fakeChant());
    expect(doc!.nodes).toHaveLength(0);
    expect(doc!.notes[0]!.text).toContain("infers no applications");
  });

  it("goes with --context only", async () => {
    let err = "";
    const code = await runGraph([".", "--logical"], { version: "0", stdout: () => {}, stderr: (t) => void (err += t) });
    expect(code).toBe(2);
    expect(err).toContain("--logical goes with --context");
  });
});

describe("the components view of a cluster read (#1132)", () => {
  it("draws each application with its health and an edge per dependsOn", async () => {
    const { doc } = await graph(["--components"], fakeChant(() => inferred));
    expect(doc!.nodes.map((n) => [n.id, n.status])).toEqual([
      ["payments", "good"],
      ["checkout", "warn"],
    ]);
    expect(doc!.edges).toEqual([expect.objectContaining({ source: "checkout", target: "payments", via: "depends on: PAYMENTS_URL", field: "ConfigMap checkout-config data.PAYMENTS_URL" })]);
    const members = (doc!.nodes[1]!.attrs.members as Array<{ id: string }>).map((m) => m.id);
    expect(members).toContain("shop/Deployment/checkout");
  });

  it("paints the same picture as an SVG, with the health on each card", async () => {
    const { out } = await graph(["--components", "--svg"], fakeChant(() => inferred));
    expect(out).toContain("depends on: PAYMENTS_URL");
    expect(out).toMatch(/font-size="11">Application · 1\/2 ready<\/text>/);
    expect(out).toMatch(/font-size="11">Application · 1\/1 ready<\/text>/);
    expect(out).not.toContain("Component · chant");
    expect(out).toMatch(/restarts: <\/tspan><tspan[^>]*>3</);
  });

  it("draws no apply waves: nothing is applied from a cluster read", async () => {
    const { doc } = await graph(["--components"], fakeChant(() => inferred));
    expect(doc!.groups ?? []).toEqual([]);
    expect(doc!.nodes.every((n) => n.box === undefined)).toBe(true);
    const { out } = await graph(["--components", "--svg"], fakeChant(() => inferred));
    expect(out).not.toContain("wave-");
  });
});

describe("each view names itself (#1132)", () => {
  it("heads the SVG with what the view shows and where it was read", async () => {
    const heading = (svg: string) => /font-size="(?:2\d|3\d)"[^>]*>([^<]+)</.exec(svg)?.[1];
    const every = await graph(["--every-card", "--namespace", "shop", "--svg"], fakeChant(() => inferred));
    expect(heading(every.out)).toBe("Every object in shop");
    const folded = await graph(["--namespace", "shop", "--svg"], fakeChant(() => inferred));
    expect(heading(folded.out)).toBe("Objects in shop");
    expect(folded.out).toContain("--every-card draws them");
    const logical = await graph(["--logical", "--namespace", "shop", "--svg"], fakeChant(() => inferred));
    expect(heading(logical.out)).toBe("shop grouped by application");
    const components = await graph(["--components", "--svg"], fakeChant(() => inferred));
    expect(components.out).toMatch(/>Applications in cluster [^<]+ and what they call</);
    expect(components.out).toContain("read from cluster ");
  });

  it("names the cluster, not a namespace, when the read took every namespace", () => {
    expect(clusterCaption("logical", false, { context: "prod" })?.title).toBe("cluster prod grouped by application");
    expect(clusterCaption("objects", true, { context: "prod", namespaces: ["a", "b"] })?.title).toBe("Every object in a, b");
    expect(clusterCaption("objects", false, undefined)).toBeUndefined();
  });
});

describe("relationship words (#1132)", () => {
  const n = (kind: string, attrs: Record<string, unknown> = {}) => ({ id: kind, kind, lexicon: "k8s", attrs }) as unknown as IRNode;
  const e = (rule: string, viaAttr = "spec") => ({ from: "a", to: "b", kind: "ref", rule, viaAttr }) as unknown as IREdge;
  it("reads the field and the kinds at each end", () => {
    const d = n("K8s::Apps::Deployment");
    expect(relationOf(e("k8s:K8s::Apps::Deployment:spec.template.spec.containers[].env[].valueFrom.secretKeyRef.name"), d, n("K8s::Core::Secret"))).toBe("reads env from");
    expect(relationOf(e("k8s:K8s::Apps::Deployment:spec.template.spec.volumes[].persistentVolumeClaim.claimName"), d, n("K8s::Core::PersistentVolumeClaim"))).toBe("mounts");
    expect(relationOf(e("k8s:K8s::Apps::Deployment:spec.template.spec.imagePullSecrets[].name"), d, n("K8s::Core::Secret"))).toBe("pulls images with");
    expect(relationOf(e("k8s:K8s::Core::Service:spec.selector.app"), n("K8s::Core::Service", { spec: { ports: [{ port: 443 }, { port: 80, targetPort: "http" }] } }), d)).toBe("routes to :443, :80 to http");
    expect(relationOf({ from: "a", to: "b", kind: "ref", viaAttr: "metadata.annotations[iam.gke.io/gcp-service-account]" } as IREdge, n("K8s::Core::ServiceAccount"), undefined)).toBe("acts as");
    expect(relationOf(e("k8s:K8s::Core::ConfigMap:metadata.namespace", "metadata"), n("K8s::Core::ConfigMap"), n("K8s::Core::Namespace"))).toBe("in namespace");
    expect(relationOf(e("k8s:K8s::Argo::Application:spec.source.repoURL"), n("K8s::Argo::Application"), undefined)).toBeUndefined();
  });
});

describe("the outside card's text (#1132)", () => {
  it("is titled with the short name and holds the whole ARN or address", () => {
    expect(outsideTitle("CloudIdentity", { role: "shop-checkout-runtime", arn: "arn:aws:iam::123456789012:role/shop-checkout-runtime" })).toBe("shop-checkout-runtime");
    expect(outsideTitle("CloudIdentity", { email: "app@demo.iam.gserviceaccount.com" })).toBe("app");
    expect(outsideTitle("Source", { repoURL: "https://example.com/org/estate.git" })).toBe("estate");
    expect(outsideFields("CloudIdentity", { arn: "arn:aws:iam::123456789012:role/shop-checkout-runtime", account: "123456789012" })).toEqual([
      { label: "role", value: "arn:aws:iam::123456789012:role/shop-checkout-runtime" },
      { label: "account", value: "123456789012" },
    ]);
    const long = `arn:aws:iam::123456789012:role/${"x".repeat(60)}`;
    expect(
      outsideFields("CloudIdentity", { arn: long })!
        .map((f) => f.value)
        .join(""),
    ).toBe(long);
    // The card for the public internet keeps its own row.
    expect(outsideFields("Internet", { reaches: "2 ways in" })).toBeUndefined();
  });

  it("is drawn in full on the SVG", async () => {
    const { out } = await graph(["--svg"], fakeChant(() => inferred));
    expect(out).toContain("shop-checkout-runtime");
    expect(out).toContain("arn:aws:iam::123456789012:role/shop-checkout-runtime");
    expect(out).not.toContain("the public in");
  });

  it("widens a card for the whole line under its title, rather than cutting it short", async () => {
    const { out } = await graph(["--svg"], fakeChant(() => inferred));
    expect(out).toContain(">ServiceAccount · k8s</text>");
    expect(out).not.toMatch(/font-size="11">[^<]*…<\/text>/);
    expect(out).not.toContain("\u200b");
  });

  it("finds a k8s icon by the kind's last word", () => {
    expect(k8sIconFor("Deployment")).toEqual(k8sIconFor("K8s::Apps::Deployment"));
  });
});

describe("chant's own inference (#1132)", async () => {
  const lister = (await import("@intentius/chant/cloud-lister/index")) as Record<string, unknown>;
  const infer = typeof lister.inferK8sComponents === "function" ? (lister.inferK8sComponents as InferApps) : undefined;
  it.skipIf(!infer)("finds checkout depending on payments, and the components view draws it", async () => {
    const { doc } = await graph(["--components"], fakeChant(infer));
    expect(doc!.nodes.map((n) => n.id).sort()).toEqual(["checkout", "payments"]);
    expect(doc!.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["checkout>payments"]);
    const logical = await graph(["--logical", "--around", "shop/Deployment/checkout", "--depth", "2"], fakeChant(infer));
    expect(logical.doc!.nodes.map((n) => n.id).sort()).toEqual(
      [ROLE, "shop/ConfigMap/checkout-config", "shop/Deployment/checkout", "shop/Secret/checkout-tls", "shop/Service/checkout", "shop/Service/payments", "shop/ServiceAccount/checkout"].sort(),
    );
  });
});
