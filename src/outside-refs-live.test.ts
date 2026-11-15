/**
 * outsideRefs (web/outside-refs.js, #1082) over what chant's live Kubernetes
 * read hands back, on a scratch k3d cluster this test creates and deletes.
 *
 * The cluster serves the CRDs of the kinds the rules read, with their schemas
 * left open, and holds one object of each. The objects are listed through
 * chant's own lister (`listCloud`, the read `behold index kubernetes` runs),
 * which masks every key matching /secret/i, so what reaches outsideRefs is what
 * a live surface would hold. The test records what that read keeps and what it
 * masks, which is the evidence behind chant#5116.
 *
 * Opt in with BEHOLD_K3D_TESTS=1 (needs docker, k3d and kubectl). The cluster is
 * named by src/scratch.ts's rules, refused if the name is taken, and deleted in
 * afterAll, by name, and only if this run created it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kubeTargetFromKubeconfig, listCloud } from "@intentius/chant/cloud-lister/index";
import { assertScratch } from "./scratch.ts";
// @ts-expect-error plain browser ESM with no declarations
import { outsideRefs } from "../web/outside-refs.js";

const has = (bin: string, ...args: string[]) => spawnSync(bin, args.length ? args : ["--version"], { encoding: "utf8" }).status === 0;
const enabled = process.env.BEHOLD_K3D_TESTS === "1" && has("k3d") && has("kubectl", "version", "--client") && has("docker");

const CLUSTER = `behold-outside-refs-${process.pid}`;

const crd = (group: string, kind: string, plural: string, scope: "Namespaced" | "Cluster", version = "v1") => ({
  apiVersion: "apiextensions.k8s.io/v1",
  kind: "CustomResourceDefinition",
  metadata: { name: `${plural}.${group}` },
  spec: {
    group,
    scope,
    names: { kind, plural, singular: kind.toLowerCase() },
    versions: [{ name: version, served: true, storage: true, schema: { openAPIV3Schema: { type: "object", "x-kubernetes-preserve-unknown-fields": true } } }],
  },
});

const CRDS = [
  crd("external-secrets.io", "ExternalSecret", "externalsecrets", "Namespaced"),
  crd("external-secrets.io", "ClusterSecretStore", "clustersecretstores", "Cluster"),
  crd("argoproj.io", "Application", "applications", "Namespaced", "v1alpha1"),
  crd("source.toolkit.fluxcd.io", "GitRepository", "gitrepositories", "Namespaced"),
  crd("kustomize.toolkit.fluxcd.io", "Kustomization", "kustomizations", "Namespaced"),
];

const OBJECTS = [
  { apiVersion: "v1", kind: "Namespace", metadata: { name: "app" } },
  { apiVersion: "v1", kind: "Namespace", metadata: { name: "argocd" } },
  { apiVersion: "v1", kind: "Namespace", metadata: { name: "flux-system" } },
  { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "runner", namespace: "app", annotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::111122223333:role/ci-runner" } } },
  { apiVersion: "external-secrets.io/v1", kind: "ClusterSecretStore", metadata: { name: "gcp" }, spec: { provider: { gcpsm: { projectID: "demo-proj" } } } },
  {
    apiVersion: "external-secrets.io/v1",
    kind: "ExternalSecret",
    metadata: { name: "app-creds", namespace: "app" },
    spec: { secretStoreRef: { name: "gcp", kind: "ClusterSecretStore" }, data: [{ secretKey: "token", remoteRef: { key: "app-token" } }] },
  },
  {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: { name: "web", namespace: "argocd" },
    spec: { source: { repoURL: "https://github.com/acme/infra.git", path: "apps/web", targetRevision: "main" } },
  },
  { apiVersion: "source.toolkit.fluxcd.io/v1", kind: "GitRepository", metadata: { name: "fleet", namespace: "flux-system" }, spec: { url: "https://github.com/acme/fleet.git" } },
  {
    apiVersion: "kustomize.toolkit.fluxcd.io/v1",
    kind: "Kustomization",
    metadata: { name: "apps", namespace: "flux-system" },
    spec: { path: "./clusters/prod", sourceRef: { kind: "GitRepository", name: "fleet" } },
  },
  {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "cluster-prod", namespace: "argocd", labels: { "argocd.argoproj.io/secret-type": "cluster" } },
    stringData: { name: "prod", server: "https://prod.example.com", config: '{"bearerToken":"hunter2"}' },
  },
];

describe.skipIf(!enabled)("outsideRefs over a live read (scratch k3d)", () => {
  let dir = "";
  let kubeconfig = "";
  let created = false;
  let objects: Array<Record<string, unknown>> = [];

  const run = (cmd: string, args: string[], input?: string, timeout = 120_000) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", input, timeout });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    return r.stdout;
  };
  const kubectl = (args: string[], input?: string) => run("kubectl", ["--kubeconfig", kubeconfig, ...args], input);

  beforeAll(async () => {
    assertScratch(CLUSTER);
    if (run("k3d", ["cluster", "list", "-o", "json"]).includes(`"name":"${CLUSTER}"`)) {
      throw new Error(`k3d cluster ${CLUSTER} already exists; remove it yourself (k3d cluster delete ${CLUSTER}) and re-run`);
    }
    dir = mkdtempSync(join(tmpdir(), "behold-outside-refs-"));
    kubeconfig = join(dir, "kubeconfig");
    run("k3d", ["cluster", "create", CLUSTER, "--wait", "--no-lb", "--kubeconfig-update-default=false", "--kubeconfig-switch-context=false"], undefined, 300_000);
    created = true;
    writeFileSync(kubeconfig, run("k3d", ["kubeconfig", "get", CLUSTER]));
    kubectl(["apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "List", items: CRDS }));
    for (const c of CRDS) kubectl(["wait", "--for=condition=established", `crd/${c.metadata.name}`, "--timeout=60s"]);
    // the namespaces first, then what lives in them
    kubectl(["apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "List", items: OBJECTS.filter((o) => o.kind === "Namespace") }));
    kubectl(["apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "List", items: OBJECTS.filter((o) => o.kind !== "Namespace") }));

    const target = kubeTargetFromKubeconfig(readFileSync(kubeconfig, "utf8"), { baseDir: dir });
    const result = await listCloud({ substrate: "kubernetes", scopeId: CLUSTER, types: "*", locations: ["app", "argocd", "flux-system", "cluster"] }, { substrate: "kubernetes", kubernetes: target });
    objects = result.resources.map((r) => r.properties as Record<string, unknown>);
  }, 420_000);

  afterAll(() => {
    if (created) {
      assertScratch(CLUSTER);
      spawnSync("k3d", ["cluster", "delete", CLUSTER], { encoding: "utf8", timeout: 120_000 });
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  const find = (kind: string, name: string) => objects.find((o) => o.kind === kind && (o.metadata as { name: string }).name === name) as Record<string, any>;

  it("shows what the read keeps and what it masks", () => {
    // the ExternalSecret's whole secretStoreRef is gone, its keys are not
    const es = find("ExternalSecret", "app-creds");
    expect(es.spec.secretStoreRef).toBe("<masked>");
    expect(es.spec.data[0].remoteRef.key).toBe("app-token");
    // the store's provider is readable
    expect(find("ClusterSecretStore", "gcp").spec.provider.gcpsm.projectID).toBe("demo-proj");
    // the Argo CD cluster Secret keeps no field at all, name and server included
    const secret = find("Secret", "cluster-prod");
    expect(secret.data).toEqual({ config: "<masked>", name: "<masked>", server: "<masked>" });
    expect(JSON.stringify(secret)).not.toContain("hunter2");
  });

  it("draws what the live read still allows, and says what waits on chant#5116", () => {
    const out = outsideRefs(objects);
    const ids = out.cards.map((c: { id: string }) => c.id);
    expect(ids).toContain("outside:identity:aws:arn:aws:iam::111122223333:role/ci-runner");
    expect(ids).toContain("outside:provider:gcpsm:demo-proj");
    expect(ids).toContain("outside:source:https://github.com/acme/infra#apps/web");
    expect(ids).toContain("outside:source:https://github.com/acme/fleet#clusters/prod");
    // the ExternalSecret reaches no store card, and no key reaches the provider card
    expect(ids.some((id: string) => id.startsWith("outside:store:"))).toBe(false);
    expect(out.cards.find((c: { id: string }) => c.id === "outside:provider:gcpsm:demo-proj").attrs.keys).toEqual([]);
    expect(out.notes).toEqual([expect.objectContaining({ code: "masked", path: "spec.secretStoreRef", waitsOn: "INTENTIUS/chant#5116" })]);
  });
});
