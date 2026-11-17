import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { kubeTargetFromKubeconfig } from "@intentius/chant/cloud-lister/index";
import { runGraph } from "./graph-cli.ts";
import type { GraphDocument } from "./graph-document.ts";
import { readJoined, storedIndexes } from "./joined-read.ts";
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

function kubeconfigFile(names: { context: string; cluster: string } = { context: "k3d-demo", cluster: "demo" }): string {
  const file = join(scratch(), "kubeconfig");
  writeFileSync(
    file,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      "current-context": names.context,
      clusters: [{ name: names.cluster, cluster: { server: "https://203.0.113.9:443", "insecure-skip-tls-verify": true } }],
      contexts: [{ name: names.context, context: { cluster: names.cluster, user: "admin" } }],
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

// behold#1123: a folder that declares the EKS cluster the context serves, and one that declares another.
const EKS_ARN = "arn:aws:eks:us-east-1:111122223333:cluster/demo";
const eksFolders = new Map<string, string>();
function eksFolder(name: string): string {
  const known = eksFolders.get(name);
  if (known) return known;
  const dir = join(scratch(), `eks-${name}`);
  eksFolders.set(name, dir);
  mkdirSync(dir);
  writeFileSync(
    join(dir, "main.tf"),
    `resource "aws_eks_cluster" "main" {
  name     = "${name}"
  role_arn = "arn:aws:iam::111122223333:role/eks"
  vpc_config {
    subnet_ids = []
  }
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

describe("the cluster's own resource joins the context it serves (#1123)", () => {
  // `aws eks update-kubeconfig` names the cluster entry by its ARN, and the context too unless --alias renames it.
  it.skipIf(gate)("joins the aws_eks_cluster the kubeconfig's cluster ARN names, with an edge to each namespace", SLOW, async () => {
    const read = await readJoined({ cluster: { kubeconfig: kubeconfigFile({ context: "prod", cluster: EKS_ARN }), chant: fakeChant(objects()) }, dir: eksFolder("demo") });
    const eks = read.ir.nodes.find((n) => n.kind === "aws_eks_cluster")!;
    expect(eks).toBeDefined();
    expect(read.joined.cluster).toBe(eks.id);
    const edge = read.ir.edges.find((e) => e.from === eks.id && e.to === "cluster/Namespace/app") as { viaAttr?: string; join?: string; inferred?: boolean } | undefined;
    expect(edge).toMatchObject({ viaAttr: "runs-on", join: "context", inferred: true });
    expect(read.meta.note).toContain(`cluster prod is ${eks.id}`);
  });

  it.skipIf(gate)("joins it by the context name when the cluster entry is named otherwise", SLOW, async () => {
    const read = await readJoined({ cluster: { kubeconfig: kubeconfigFile({ context: EKS_ARN, cluster: "kubernetes" }), chant: fakeChant(objects()) }, dir: eksFolder("demo") });
    expect(read.joined.cluster).toBe(read.ir.nodes.find((n) => n.kind === "aws_eks_cluster")!.id);
  });

  it.skipIf(gate)("joins nothing when the folder's cluster is another one, and says so", SLOW, async () => {
    const read = await readJoined({ cluster: { kubeconfig: kubeconfigFile({ context: "prod", cluster: EKS_ARN }), chant: fakeChant(objects()) }, dir: eksFolder("other") });
    expect(read.joined.cluster).toBeUndefined();
    expect(read.ir.edges.some((e) => (e as { join?: string }).join === "context")).toBe(false);
    expect(read.meta.note).toContain("declares 1 cluster, and the context names none of them");
  });
});

// behold#1123: a local repository an Argo CD Application and a Flux Kustomization deploy from.
const GUESTBOOK = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: guestbook
  namespace: guestbook
spec:
  selector:
    matchLabels: { app: guestbook }
  template:
    metadata:
      labels: { app: guestbook }
    spec:
      containers:
        - name: web
          image: nginx:1.27
---
apiVersion: v1
kind: Service
metadata:
  name: guestbook
  namespace: guestbook
spec:
  selector: { app: guestbook }
  ports: [{ port: 80 }]
`;
let repo: string | undefined;
function gitRepo(): string {
  if (repo) return repo;
  const dir = join(scratch(), "deploy-repo");
  repo = dir;
  mkdirSync(join(dir, "apps", "guestbook"), { recursive: true });
  writeFileSync(join(dir, "apps", "guestbook", "all.yaml"), GUESTBOOK);
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://git.example.test/team/deploy.git"]);
  return dir;
}

const gitObjects = (repoURL: string): Obj[] => [
  ...objects(),
  {
    listedType: "argoproj.io/v1alpha1/Application",
    location: "argocd",
    name: "guestbook",
    attrs: { spec: { project: "default", source: { repoURL, path: "apps/guestbook", targetRevision: "main" }, destination: { server: "https://kubernetes.default.svc", namespace: "guestbook" } } },
  },
  { listedType: "apps/v1/Deployment", location: "guestbook", name: "guestbook", typed: "K8s::Apps::Deployment" },
];

const fluxObjects = (): Obj[] => [
  ...objects(),
  { listedType: "source.toolkit.fluxcd.io/v1/GitRepository", location: "flux-system", name: "deploy", attrs: { spec: { url: "ssh://git@git.example.test/team/deploy.git", ref: { branch: "main" }, interval: "1m" } } },
  { listedType: "kustomize.toolkit.fluxcd.io/v1/Kustomization", location: "flux-system", name: "guestbook", attrs: { spec: { path: "./apps/guestbook", sourceRef: { kind: "GitRepository", name: "deploy" }, interval: "1m", prune: true } } },
];

describe("the GitOps source: an app's manifests from git beside the live objects (#1123)", () => {
  it.skipIf(gate)("reads the path an Argo CD Application names from the local clone given with --git <dir>", SLOW, async () => {
    const dir = gitRepo();
    const read = await readJoined({ cluster: { kubeconfig: kubeconfigFile(), chant: fakeChant(gitObjects(`file://${dir}`)) }, git: [{ dir }] });
    const fromGit = read.ir.nodes.filter((n) => (n as { read?: string }).read === "git");
    expect(fromGit.map((n) => n.kind).sort()).toEqual(["K8s::Apps::Deployment", "K8s::Core::Service"]);
    expect(fromGit.every((n) => n.id.startsWith("argocd/Application/guestbook/git/"))).toBe(true);
    // The live Deployment is drawn beside the one git declares.
    expect(read.ir.nodes.some((n) => n.id === "guestbook/Deployment/guestbook" && (n as { read?: string }).read === "cluster")).toBe(true);
    const box = (read.ir.groups as { byStack: Record<string, string[]> }).byStack["argocd/Application/guestbook from git"];
    expect(box?.sort()).toEqual(fromGit.map((n) => n.id).sort());
    expect(read.joined.git).toMatchObject([{ app: "argocd/Application/guestbook", path: "apps/guestbook", revision: "main", cards: 2 }]);
    expect(read.meta.note).toContain("2 cards of argocd/Application/guestbook from git");
  });

  it.skipIf(gate)("finds the clone by its remote, so an https repoURL reads with no fetch", SLOW, async () => {
    const read = await readJoined({ cluster: { kubeconfig: kubeconfigFile(), chant: fakeChant(gitObjects("https://git.example.test/team/deploy")) }, git: [{ dir: gitRepo() }] });
    expect(read.ir.nodes.filter((n) => (n as { read?: string }).read === "git")).toHaveLength(2);
  });

  it.skipIf(gate)("reads a Flux Kustomization's path in the GitRepository it names, from --git <url>=<dir>", SLOW, async () => {
    const read = await readJoined({ cluster: { kubeconfig: kubeconfigFile(), chant: fakeChant(fluxObjects()) }, git: [{ url: "ssh://git@git.example.test/team/deploy.git", dir: gitRepo() }] });
    const fromGit = read.ir.nodes.filter((n) => (n as { read?: string }).read === "git");
    expect(fromGit).toHaveLength(2);
    expect(fromGit.every((n) => n.id.startsWith("flux-system/Kustomization/guestbook/git/"))).toBe(true);
    expect(read.joined.git).toMatchObject([{ via: "Kustomization", path: "apps/guestbook", revision: "main" }]);
  });

  it.skipIf(gate)("reads nothing for a repository no clone holds, and says how to give one", SLOW, async () => {
    const read = await readJoined({ cluster: { kubeconfig: kubeconfigFile(), chant: fakeChant(gitObjects("https://git.example.test/team/other")) }, git: [{ dir: gitRepo() }] });
    expect(read.ir.nodes.some((n) => (n as { read?: string }).read === "git")).toBe(false);
    expect(read.joined.git).toMatchObject([{ app: "argocd/Application/guestbook", cards: 0 }]);
    expect(read.meta.note).toContain("https://git.example.test/team/other, which no --git clone holds");
  });

  it.skipIf(gate)("behold graph --context --git prints the git cards beside the live ones, with read: git", SLOW, async () => {
    const dir = gitRepo();
    const r = await graph(["--kubeconfig", kubeconfigFile(), "--git", dir, "--json"], fakeChant(gitObjects(`file://${dir}`)));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as GraphDocument;
    expect(doc.nodes.filter((n) => n.read === "git").map((n) => n.kind).sort()).toEqual(["K8s::Apps::Deployment", "K8s::Core::Service"]);
    expect(doc.nodes.filter((n) => n.read === "git").every((n) => n.id.startsWith("argocd/Application/guestbook/git/"))).toBe(true);
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

// behold#1123: the cloud index joined to a cluster read. The index versions are
// what `behold index aws` wrote for floci (chant#5245's fixtures), kept in a
// scratch store; chant's `indexedMemberNodes` hands them to the catalog pass,
// and the aws lexicon gives the pass the role's and the secret's identities.
const awsLexicon = resolvedVersion("@intentius/chant-lexicon-aws");
const noAws = !awsLexicon && process.env.BEHOLD_REQUIRE_PEERS !== "1";
const ACCOUNT = "111122223333";

const indexedRole = (account: string, name: string) => {
  const arn = `arn:aws:iam::${account}:role/${name}`;
  return {
    id: `aws/${account}/global/AWS::IAM::Role/${name}`,
    kind: "AWS::IAM::Role",
    lexicon: "aws",
    attrs: { Path: "/", RoleName: name },
    physicalId: name,
    nativeId: name,
    listedType: "AWS::IAM::Role",
    location: "global",
    facts: { cloudIds: [{ kind: "arn", value: arn }, { kind: "import-id", value: name }], observedAt: "2026-11-17T04:19:31.444Z" },
  };
};
const indexedSecret = (account: string, region: string, name: string) => {
  const arn = `arn:aws:secretsmanager:${region}:${account}:secret:${name}-7HZH6J`;
  return {
    id: `aws/${account}/${region}/AWS::SecretsManager::Secret/${arn}`,
    kind: "AWS::SecretsManager::Secret",
    lexicon: "aws",
    attrs: { Name: name },
    physicalId: arn,
    nativeId: arn,
    listedType: "AWS::SecretsManager::Secret",
    location: region,
    facts: { cloudIds: [{ kind: "arn", value: arn }], observedAt: "2026-11-17T04:19:31.482Z" },
  };
};
const indexVersion = (account: string, nodes: object[], observedAt = "2026-11-17T04:19:31.411Z") => ({
  index: "v1",
  stamp: { source: { kind: "cloud", name: "behold index" }, scope: { kind: "cloud", substrate: "aws", scopeId: account, locations: ["us-east-1"], types: "*" }, scopeKey: `cloud/aws/${account}/fe73c8a16670`, observedAt, digest: "0".repeat(64) },
  coverage: [],
  graph: { version: 1, nodes, edges: [], groups: {} },
});

/** A scratch store laid out as chant's `index` family, as behold index writes it. */
function indexStore(versions: Array<{ name: string; doc: object }>): string {
  const root = join(scratch(), "index");
  for (const v of versions) {
    const doc = v.doc as { stamp: { scopeKey: string } };
    const dir = join(root, doc.stamp.scopeKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, v.name), JSON.stringify(v.doc));
  }
  return root;
}

const accountIndex = () => indexVersion(ACCOUNT, [indexedRole(ACCOUNT, "app"), indexedRole(ACCOUNT, "unrelated"), indexedSecret(ACCOUNT, "us-east-1", "app/token"), indexedSecret(ACCOUNT, "us-east-1", "app/other")]);

describe("the cloud index joined to a cluster read (#1123)", () => {
  it("reads the newest version of each aws scope in the store, and nothing of another substrate", () => {
    const older = indexVersion(ACCOUNT, [], "2026-11-16T00:00:00.000Z");
    const gcp = { ...indexVersion("demo-proj", []), stamp: { ...indexVersion("demo-proj", []).stamp, scope: { kind: "cloud", substrate: "gcp", scopeId: "demo-proj" }, scopeKey: "cloud/gcp/demo-proj/0123456789ab" } };
    const root = indexStore([
      { name: "20261116T000000Z-aaaaaaaaaaaa.json", doc: older },
      { name: "20261117T041931Z-bbbbbbbbbbbb.json", doc: accountIndex() },
      { name: "20261117T041931Z-cccccccccccc.json", doc: gcp },
    ]);
    const { found, stores } = storedIndexes("aws", undefined, { BEHOLD_INDEX_DIR: root });
    expect(stores).toEqual([root]);
    expect(found.map((f) => f.version)).toEqual(["20261117T041931Z-bbbbbbbbbbbb.json"]);
    expect(found[0]!.doc.graph.nodes).toHaveLength(4);
  });

  it.skipIf(noAws)("draws the role a ServiceAccount assumes and the secret an ExternalSecret reads as indexed cards, with edges from the cluster objects", async () => {
    const read = await readJoined({
      cluster: { kubeconfig: kubeconfigFile(), chant: fakeChant(objects(`arn:aws:iam::${ACCOUNT}:role/app`)) },
      index: ["aws"],
      deps: { indexes: () => ({ found: [{ doc: accountIndex() as never, from: "store", version: "20261117T041931Z-bbbbbbbbbbbb.json" }], stores: ["store"] }) },
    });
    const role = `aws/${ACCOUNT}/global/AWS::IAM::Role/app`;
    const secret = `aws/${ACCOUNT}/us-east-1/AWS::SecretsManager::Secret/arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:app/token-7HZH6J`;
    const edge = (from: string, to: string) => read.ir.edges.find((e) => e.from === from && e.to === to) as (GraphIR["edges"][number] & { rule?: string; origin?: string }) | undefined;
    expect(edge("app/ServiceAccount/app", role)).toMatchObject({ origin: "derived", rule: 'k8s:K8s::Core::ServiceAccount:metadata.annotations["eks.amazonaws.com/role-arn"]' });
    expect(edge("app/ExternalSecret/app-creds", secret)).toMatchObject({ origin: "derived", viaAttr: "remoteRef.key via aws" });
    // Only what an edge reaches is drawn, each card marked as read from the index, in the account's box.
    const fromIndex = read.ir.nodes.filter((n) => (n as { read?: string }).read === "index");
    expect(fromIndex.map((n) => n.id).sort()).toEqual([role, secret].sort());
    expect((read.ir.groups as { byStack: Record<string, string[]> }).byStack[`aws ${ACCOUNT} (index)`]?.sort()).toEqual([role, secret].sort());
    // The index holds the role and app/token, so neither is a placeholder; app/db-password stays one.
    expect(read.ir.nodes.some((n) => n.id.startsWith("outside:identity:"))).toBe(false);
    expect(read.ir.nodes.find((n) => n.kind === "SecretProvider")?.attrs).toMatchObject({ keys: ["app/db-password"] });
    expect(read.joined.index).toMatchObject([{ substrate: "aws", scopeId: ACCOUNT, nodes: 4, drawn: 2 }]);
    expect(read.meta.note).toContain(`joined with the aws index (${ACCOUNT} as of 2026-11-17T04:19:31.411Z): 4 indexed resources read, 2 drawn, 2 edges to them drawn by chant's reference catalog`);
  });

  it.skipIf(noAws)("gives a role of that name in another account no edge, and keeps the placeholder", async () => {
    const other = "444455556666";
    const read = await readJoined({
      cluster: { kubeconfig: kubeconfigFile(), chant: fakeChant(objects(`arn:aws:iam::${ACCOUNT}:role/app`)) },
      index: ["aws"],
      deps: { indexes: () => ({ found: [{ doc: indexVersion(other, [indexedRole(other, "app")]) as never, from: "store", version: "v" }], stores: ["store"] }) },
    });
    expect(read.ir.nodes.some((n) => (n as { read?: string }).read === "index")).toBe(false);
    expect(read.ir.edges.some((e) => e.from === "app/ServiceAccount/app" && e.to.startsWith("aws/"))).toBe(false);
  });

  it("names the store it looked in when it holds no index of the substrate", async () => {
    const read = await readJoined({ cluster: { kubeconfig: kubeconfigFile(), chant: fakeChant(objects()) }, index: ["aws"], deps: { indexes: () => ({ found: [], stores: ["/scratch/index"] }) } });
    expect(read.joined.index).toEqual([]);
    expect(read.meta.note).toContain("no aws index is stored (looked in /scratch/index): run behold index aws to fill one");
  });

  it("says so when the chant beside behold has no indexedMemberNodes", async () => {
    const read = await readJoined({
      cluster: { kubeconfig: kubeconfigFile(), chant: fakeChant(objects()) },
      index: ["aws"],
      deps: { indexedNodes: async () => undefined, indexes: () => ({ found: [{ doc: accountIndex() as never, from: "store", version: "v" }], stores: ["store"] }) },
    });
    expect(read.ir.nodes.some((n) => (n as { read?: string }).read === "index")).toBe(false);
    expect(read.meta.note).toContain("has no indexedMemberNodes");
  });

  it.skipIf(noAws)("behold graph --context --index aws prints the indexed role with read: index", async () => {
    const root = indexStore([{ name: "20261117T041931Z-bbbbbbbbbbbb.json", doc: accountIndex() }]);
    const before = process.env.BEHOLD_INDEX_DIR;
    process.env.BEHOLD_INDEX_DIR = root;
    try {
      const r = await graph(["--kubeconfig", kubeconfigFile(), "--index", "aws", "--json"], fakeChant(objects(`arn:aws:iam::${ACCOUNT}:role/app`)));
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.out) as GraphDocument;
      const role = doc.nodes.find((n) => n.kind === "AWS::IAM::Role")!;
      expect(role.read).toBe("index");
      expect(doc.edges.some((e) => e.source === "app/ServiceAccount/app" && e.target === role.id)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.BEHOLD_INDEX_DIR;
      else process.env.BEHOLD_INDEX_DIR = before;
    }
  });

  it("behold graph refuses --index without --context, and a substrate it does not read", async () => {
    expect((await graph(["--index", "aws"], fakeChant([]))).err).toContain("--index goes with --context");
    expect((await graph(["--kubeconfig", "k", "--index", "kubernetes"], fakeChant([]))).err).toContain("--index takes aws, azure, gcp");
  });
});
