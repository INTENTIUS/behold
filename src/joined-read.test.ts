import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { kubeTargetFromKubeconfig } from "@intentius/chant/cloud-lister/index";
import { runGraph } from "./graph-cli.ts";
import type { GraphDocument } from "./graph-document.ts";
import { readJoined } from "./joined-read.ts";
import type { ChantLister } from "./read-cluster.ts";
import { HCL_PARSER_PKG, resolvedVersion, TERRAFORM_LEXICON_PKG } from "./terraform-member.ts";

// behold#1115: a cluster and a folder of Terraform as one graph. The lister is
// replaced by one that answers what chant's live read gives for these objects
// (a ServiceAccount typed by the k8s lexicon, External Secrets kinds under their
// listed type); the folder is read by the chant beside behold, and the edges
// between the two come from chant's own catalog pass. The live proof on a
// scratch cluster is in the pull request. The folder is read through the real
// chant, so the tests wait on the Terraform reader as graph-cli.test.ts does,
// and share one folder, which the member cache then reads once per detail.

const gate = !(resolvedVersion(TERRAFORM_LEXICON_PKG) && resolvedVersion(HCL_PARSER_PKG)) && process.env.BEHOLD_REQUIRE_PEERS !== "1";
const SLOW = { timeout: 240_000 };

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "behold-1115-"));
  made.push(d);
  return d;
};

function kubeconfigFile(): string {
  const file = join(scratch(), "kubeconfig");
  writeFileSync(
    file,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      "current-context": "k3d-demo",
      clusters: [{ name: "demo", cluster: { server: "https://203.0.113.9:443", "insecure-skip-tls-verify": true } }],
      contexts: [{ name: "k3d-demo", context: { cluster: "demo", user: "admin" } }],
      users: [{ name: "admin", user: { token: "t" } }],
    }),
  );
  return file;
}

type Obj = { listedType: string; location: string; name: string; typed?: string; attrs?: Record<string, unknown> };

function fakeChant(objects: Obj[]): ChantLister {
  const nodes = objects.map((o) => {
    const [kind] = o.listedType.split("/").slice(-1);
    const apiVersion = o.listedType.split("/").slice(0, -1).join("/");
    return {
      id: `kubernetes/demo/${o.location}/${encodeURIComponent(o.listedType)}/${o.name}`,
      kind: o.typed ?? o.listedType,
      lexicon: o.typed ? "k8s" : "kubernetes",
      listedType: o.listedType,
      location: o.location,
      attrs: {
        ...(o.typed ? {} : { apiVersion, kind }),
        metadata: { name: o.name, ...(o.location === "cluster" ? {} : { namespace: o.location }) },
        ...(o.attrs ?? {}),
      },
    };
  });
  return {
    kubeTarget: (text, opts) => ({ ...kubeTargetFromKubeconfig(text, opts) }),
    noneStore: async () => ({ kind: "none" }),
    lexicons: async () => [],
    indexCloud: async () => ({
      doc: { stamp: { observedAt: "2026-11-16T00:00:00.000Z", scope: {} }, coverage: [], notes: [], graph: { version: 1, nodes, edges: [], groups: {} } as unknown as GraphIR },
    }),
  };
}

const ROLE_ARN = "arn:aws:iam::111122223333:role/app";

const objects = (roleArn = ROLE_ARN): Obj[] => [
  { listedType: "v1/Namespace", location: "cluster", name: "app", typed: "K8s::Core::Namespace" },
  { listedType: "v1/ServiceAccount", location: "app", name: "app", typed: "K8s::Core::ServiceAccount", attrs: { metadata: { name: "app", namespace: "app", annotations: { "eks.amazonaws.com/role-arn": roleArn } } } },
  { listedType: "external-secrets.io/v1/ClusterSecretStore", location: "cluster", name: "aws", attrs: { spec: { provider: { aws: { service: "SecretsManager", region: "us-east-1" } } } } },
  {
    listedType: "external-secrets.io/v1/ExternalSecret",
    location: "app",
    name: "app-creds",
    attrs: { spec: { secretStoreRef: { name: "aws", kind: "ClusterSecretStore" }, data: [{ secretKey: "[REDACTED]", remoteRef: { key: "app/token" } }] } },
  },
  {
    listedType: "external-secrets.io/v1/ExternalSecret",
    location: "app",
    name: "db-creds",
    attrs: { spec: { secretStoreRef: { name: "aws", kind: "ClusterSecretStore" }, data: [{ secretKey: "[REDACTED]", remoteRef: { key: "app/db-password" } }] } },
  },
];

let infra: string | undefined;
function infraFolder(): string {
  if (infra) return infra;
  const dir = join(scratch(), "infra");
  infra = dir;
  mkdirSync(dir);
  writeFileSync(
    join(dir, "main.tf"),
    `resource "aws_iam_role" "app" {
  name               = "app"
  assume_role_policy = "{}"
}

resource "aws_secretsmanager_secret" "app_token" {
  name = "app/token"
}
`,
  );
  return dir;
}

async function graph(argv: string[], chant: ChantLister): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runGraph(argv, { version: "0.0.0-test", chant, stdout: (t) => void (out += String(t)), stderr: (t) => void (err += t) });
  return { code, out, err };
}

describe("readJoined, a cluster and a folder as one graph (#1115)", () => {
  it.skipIf(gate)("draws the role and the secret as Terraform cards with edges from the cluster objects, and no placeholder for either", SLOW, async () => {
    const read = await readJoined({ cluster: { kubeconfig: kubeconfigFile(), chant: fakeChant(objects()) }, dir: infraFolder() });
    const ids = read.ir.nodes.map((n) => n.id);
    const role = ids.find((id) => id.endsWith("aws_iam_role.app"))!;
    const secret = ids.find((id) => id.endsWith("aws_secretsmanager_secret.app_token"))!;
    expect(role).toBeDefined();
    expect(secret).toBeDefined();
    const edge = (from: string, to: string) => read.ir.edges.find((e) => e.from === from && e.to === to) as (GraphIR["edges"][number] & { rule?: string; origin?: string }) | undefined;
    expect(edge("app/ServiceAccount/app", role)).toMatchObject({ origin: "derived", rule: 'k8s:K8s::Core::ServiceAccount:metadata.annotations["eks.amazonaws.com/role-arn"]' });
    expect(edge("app/ExternalSecret/app-creds", secret)).toMatchObject({ origin: "derived", viaAttr: "remoteRef.key via aws" });
    // The live read leaves the store kinds untyped; the pass joins them under the kind the k8s lexicon's group rule gives.
    expect(edge("app/ExternalSecret/app-creds", "cluster/ClusterSecretStore/aws")).toBeDefined();
    expect(ids.some((id) => id.startsWith("outside:identity:"))).toBe(false);
    expect(read.joined).toMatchObject({ pass: true, placeholders: 1 });
  });

  it.skipIf(gate)("keeps a placeholder for what the folder does not hold, and the note names the folder", SLOW, async () => {
    const read = await readJoined({ cluster: { kubeconfig: kubeconfigFile(), chant: fakeChant(objects("arn:aws:iam::111122223333:role/other")) }, dir: infraFolder() });
    const outside = read.ir.nodes.filter((n) => n.lexicon === "outside");
    expect(outside.map((n) => n.id).sort()).toEqual(["outside:identity:aws:arn:aws:iam::111122223333:role/other", "outside:provider:aws:SecretsManager:us-east-1"]);
    // The provider card keeps only the key the folder does not declare.
    expect(outside.find((n) => n.kind === "SecretProvider")?.attrs).toMatchObject({ keys: ["app/db-password"] });
    expect(read.ir.edges.some((e) => e.from === "app/ServiceAccount/app" && e.to.endsWith("aws_iam_role.app"))).toBe(false);
    expect(read.meta.note).toContain("joined with infra");
    expect(read.meta.note).toContain("2 cards stand for what neither the cluster nor infra holds");
  });

  it.skipIf(gate)("marks every card with the source it was read from", SLOW, async () => {
    const read = await readJoined({ cluster: { kubeconfig: kubeconfigFile(), chant: fakeChant(objects()) }, dir: infraFolder() });
    const reads = new Map(read.ir.nodes.map((n) => [n.id, (n as { read?: string }).read]));
    expect([...reads.values()].every((r) => r === "cluster" || r === "folder")).toBe(true);
    expect(reads.get("app/ServiceAccount/app")).toBe("cluster");
    expect(reads.get("outside:provider:aws:SecretsManager:us-east-1")).toBe("cluster");
    expect([...reads].filter(([id]) => id.startsWith("infra/")).every(([, r]) => r === "folder")).toBe(true);
  });

  it.skipIf(gate)("without chant's catalog pass draws the two side by side and says why", SLOW, async () => {
    const read = await readJoined({ cluster: { kubeconfig: kubeconfigFile(), chant: fakeChant(objects()) }, dir: infraFolder(), deps: { catalogPass: async () => undefined } });
    expect(read.joined.pass).toBe(false);
    expect(read.joined.edges).toBe(0);
    expect(read.meta.note).toContain("no catalog pass");
  });
});

describe("behold graph --context <ctx> <dir> (#1115)", () => {
  it.skipIf(gate)("prints one document whose cards carry read", SLOW, async () => {
    const dir = infraFolder();
    const r = await graph(["--kubeconfig", kubeconfigFile(), dir, "--json"], fakeChant(objects()));
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as GraphDocument;
    expect(doc.nodes.every((n) => n.read === "cluster" || n.read === "folder")).toBe(true);
    const role = doc.nodes.find((n) => n.kind === "aws_iam_role")!;
    expect(role.read).toBe("folder");
    expect(doc.edges.some((e) => e.source === "app/ServiceAccount/app" && e.target === role.id && e.inferred)).toBe(true);
    expect(doc.notes.map((n) => n.text).join(" ")).toContain("joined with infra");
  });

  it.skipIf(gate)("takes the folder as --infra too", SLOW, async () => {
    const r = await graph(["--kubeconfig", kubeconfigFile(), "--context", "k3d-demo", "--infra", infraFolder(), "--json"], fakeChant(objects()));
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as GraphDocument).nodes.some((n) => n.read === "folder")).toBe(true);
  });

  it.skipIf(gate)("marks a cluster read alone as read from the cluster", SLOW, async () => {
    const r = await graph(["--kubeconfig", kubeconfigFile(), "--json"], fakeChant(objects()));
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as GraphDocument).nodes.every((n) => n.read === "cluster")).toBe(true);
  });
});
