import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { outsideRefs, normalizeUrl } from "./outside-refs.js";

const sa = (name, annotations, namespace = "ci") => ({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name, namespace, annotations } });
const clusterStore = (name, provider) => ({ apiVersion: "external-secrets.io/v1", kind: "ClusterSecretStore", metadata: { name }, spec: { provider } });
const store = (name, namespace, provider) => ({ apiVersion: "external-secrets.io/v1", kind: "SecretStore", metadata: { name, namespace }, spec: { provider } });
const externalSecret = (name, namespace, storeRef, keys, extra = {}) => ({
  apiVersion: "external-secrets.io/v1",
  kind: "ExternalSecret",
  metadata: { name, namespace },
  spec: { secretStoreRef: storeRef, data: keys.map((key) => ({ secretKey: "v", remoteRef: { key } })), ...extra },
});
const tf = (id, kind, body) => ({ id, kind, lexicon: "terraform", attrs: { address: id, body } });

const ARN = "arn:aws:iam::111122223333:role/ci-runner";
const GCP_STORE = clusterStore("gcp", { gcpsm: { projectID: "demo-proj" } });

describe("ServiceAccount annotations", () => {
  it("gives an IRSA role one card labelled with the role and an edge from the account", () => {
    const out = outsideRefs([sa("runner", { "eks.amazonaws.com/role-arn": ARN })]);
    expect(out.cards).toEqual([
      { id: `outside:identity:aws:${ARN}`, kind: "CloudIdentity", label: ARN, placeholder: true, attrs: { cloud: "aws", arn: ARN, account: "111122223333", role: "ci-runner" } },
    ]);
    expect(out.edges).toEqual([
      {
        from: "/ServiceAccount/ci/runner",
        fromRef: { group: "", kind: "ServiceAccount", namespace: "ci", name: "runner" },
        to: `outside:identity:aws:${ARN}`,
        kind: "ref",
        viaAttr: "metadata.annotations[eks.amazonaws.com/role-arn]",
        inferred: true,
        placeholder: true,
      },
    ]);
    expect(out.notes).toEqual([]);
  });

  it("shares one card between two accounts with the same annotation", () => {
    const out = outsideRefs([sa("a", { "eks.amazonaws.com/role-arn": ARN }), sa("b", { "eks.amazonaws.com/role-arn": ARN }, "other")]);
    expect(out.cards).toHaveLength(1);
    expect(out.edges.map((e) => e.from)).toEqual(["/ServiceAccount/ci/a", "/ServiceAccount/other/b"]);
  });

  it("reads the GKE and Azure annotations", () => {
    const out = outsideRefs([
      sa("g", { "iam.gke.io/gcp-service-account": "runner@demo-proj.iam.gserviceaccount.com" }),
      sa("z", { "azure.workload.identity/client-id": "AAAA-BBBB" }),
    ]);
    expect(out.cards.map((c) => c.id)).toEqual(["outside:identity:azure:aaaa-bbbb", "outside:identity:gcp:runner@demo-proj.iam.gserviceaccount.com"]);
    expect(out.cards[1].attrs).toEqual({ cloud: "gcp", email: "runner@demo-proj.iam.gserviceaccount.com", project: "demo-proj" });
  });

  it("returns no card for a role the graph already holds", () => {
    const graph = { nodes: [tf("tf/aws_iam_role.ci", "aws_iam_role", { name: "ci-runner" })] };
    expect(outsideRefs([sa("runner", { "eks.amazonaws.com/role-arn": ARN })], { graph })).toEqual({ cards: [], edges: [], notes: [] });
  });

  it("holds a role by an address in the node id and a service account by account_id and project", () => {
    const graph = {
      nodes: [
        { id: "tf/module.x.aws_iam_role.ci[0]", kind: "Terraform::Resource", lexicon: "terraform", attrs: { arn: ARN } },
        tf("tf/google_service_account.r", "google_service_account", { account_id: "runner", project: "demo-proj" }),
      ],
    };
    const out = outsideRefs([sa("a", { "eks.amazonaws.com/role-arn": ARN }), sa("b", { "iam.gke.io/gcp-service-account": "runner@demo-proj.iam.gserviceaccount.com" })], { graph });
    expect(out.cards).toEqual([]);
  });

  it("does not take a service account in another project as the held one", () => {
    const graph = { nodes: [tf("tf/google_service_account.r", "google_service_account", { account_id: "runner", project: "other-proj" })] };
    const out = outsideRefs([sa("b", { "iam.gke.io/gcp-service-account": "runner@demo-proj.iam.gserviceaccount.com" })], { graph });
    expect(out.cards).toHaveLength(1);
  });

  it("puts an annotation it cannot read in notes", () => {
    const out = outsideRefs([sa("a", { "eks.amazonaws.com/role-arn": "not-an-arn" }), sa("b", { "iam.gke.io/gcp-service-account": "<masked>" })]);
    expect(out.cards).toEqual([]);
    expect(out.notes.map((n) => [n.code, n.path])).toEqual([
      ["unrecognised", "metadata.annotations[eks.amazonaws.com/role-arn]"],
      ["masked", "metadata.annotations[iam.gke.io/gcp-service-account]"],
    ]);
  });
});

describe("ExternalSecret and its store", () => {
  const es = externalSecret("app-creds", "app", { name: "gcp", kind: "ClusterSecretStore" }, ["app-token"]);

  it("gives a store card and a provider card naming the project and the key", () => {
    const out = outsideRefs([GCP_STORE, es]);
    expect(out.cards).toEqual([
      {
        id: "outside:provider:gcpsm:demo-proj",
        kind: "SecretProvider",
        label: "GCP Secret Manager demo-proj",
        placeholder: true,
        attrs: { provider: "gcpsm", projectID: "demo-proj", keys: ["app-token"] },
      },
      { id: "outside:store:ClusterSecretStore/gcp", kind: "SecretStore", label: "ClusterSecretStore gcp", placeholder: true, attrs: { storeKind: "ClusterSecretStore", name: "gcp", read: true } },
    ]);
    expect(out.edges.map((e) => [e.from, e.to, e.viaAttr])).toEqual([
      ["external-secrets.io/ClusterSecretStore//gcp", "outside:provider:gcpsm:demo-proj", "spec.provider.gcpsm"],
      ["external-secrets.io/ExternalSecret/app/app-creds", "outside:store:ClusterSecretStore/gcp", "spec.secretStoreRef"],
    ]);
    expect(out.notes).toEqual([]);
  });

  it("collects the keys of every secret that uses the store, and dataFrom extract keys", () => {
    const more = externalSecret("db", "app", { name: "gcp", kind: "ClusterSecretStore" }, ["db-pass"], { dataFrom: [{ extract: { key: "bulk" } }] });
    const out = outsideRefs([GCP_STORE, es, more]);
    expect(out.cards.find((c) => c.kind === "SecretProvider").attrs.keys).toEqual(["app-token", "bulk", "db-pass"]);
  });

  it("looks a SecretStore up in the secret's own namespace", () => {
    const other = store("gcp", "elsewhere", { gcpsm: { projectID: "other-proj" } });
    const ns = externalSecret("app-creds", "app", { name: "gcp" }, ["k"]);
    const out = outsideRefs([other, ns]);
    expect(out.cards.map((c) => c.id)).toEqual(["outside:provider:gcpsm:other-proj", "outside:store:SecretStore/app/gcp"]);
    // the store in "elsewhere" is not the one "app" uses: its card says it was not read, and a note says why
    expect(out.cards[1].attrs.read).toBe(false);
    expect(out.notes.map((n) => n.code)).toEqual(["unresolved"]);
    // and the key went nowhere
    expect(out.cards[0].attrs.keys).toEqual([]);
  });

  it("reads AWS and Vault providers", () => {
    const out = outsideRefs([
      clusterStore("aws", { aws: { service: "SecretsManager", region: "eu-west-1" } }),
      clusterStore("vault", { vault: { server: "https://vault.example.com", path: "secret" } }),
      externalSecret("a", "app", { name: "aws", kind: "ClusterSecretStore" }, ["prod/db"]),
    ]);
    expect(out.cards.map((c) => [c.id, c.label])).toEqual([
      ["outside:provider:aws:SecretsManager:eu-west-1", "AWS Secrets Manager eu-west-1"],
      ["outside:provider:vault:https://vault.example.com/secret", "Vault https://vault.example.com/secret"],
      ["outside:store:ClusterSecretStore/aws", "ClusterSecretStore aws"],
    ]);
    expect(out.cards[0].attrs.keys).toEqual(["prod/db"]);
  });

  it("drops a key the graph holds from the provider card, and the store card when the graph holds the store", () => {
    const graph = {
      nodes: [
        tf("tf/google_secret_manager_secret.t", "google_secret_manager_secret", { secret_id: "app-token", project: "demo-proj" }),
        { id: "k/gcp", kind: "K8s::Core::ClusterSecretStore", lexicon: "k8s", attrs: { kind: "ClusterSecretStore", metadata: { name: "gcp" } } },
      ],
    };
    const out = outsideRefs([GCP_STORE, es, externalSecret("b", "app", { name: "gcp", kind: "ClusterSecretStore" }, ["other-token"])], { graph });
    expect(out.cards.map((c) => c.id)).toEqual(["outside:provider:gcpsm:demo-proj"]);
    expect(out.cards[0].attrs.keys).toEqual(["other-token"]);
    expect(out.edges.map((e) => e.to)).toEqual(["outside:provider:gcpsm:demo-proj"]);
  });

  it("puts a provider with no rule and a dataFrom with no key in notes", () => {
    const out = outsideRefs([
      clusterStore("ibm", { ibm: { serviceUrl: "https://x" } }),
      externalSecret("a", "app", { name: "ibm", kind: "ClusterSecretStore" }, [], { dataFrom: [{ find: { name: { regexp: "x" } } }] }),
    ]);
    expect(out.cards.map((c) => c.id)).toEqual(["outside:store:ClusterSecretStore/ibm"]);
    expect(out.notes.map((n) => n.path).sort()).toEqual(["spec.dataFrom[0]", "spec.provider.ibm"]);
  });

  it("notes a masked secretStoreRef and names the ruling it waits on, joining nothing", () => {
    // what chant's live read hands back: any key matching /secret/i is masked whole
    const live = { ...externalSecret("app-creds", "app", "<masked>", ["app-token"]) };
    live.spec.secretStoreRef = "<masked>";
    const out = outsideRefs([GCP_STORE, live]);
    expect(out.notes).toEqual([
      {
        code: "masked",
        from: "external-secrets.io/ExternalSecret/app/app-creds",
        path: "spec.secretStoreRef",
        message: "the live read masked secretStoreRef, so the store and the keys cannot be joined",
        waitsOn: "INTENTIUS/chant#5116",
      },
    ]);
    // the store object still gives its provider card, with no keys
    expect(out.cards.map((c) => [c.id, c.attrs.keys])).toEqual([["outside:provider:gcpsm:demo-proj", []]]);
  });
});

describe("sources", () => {
  const app = (name, spec) => ({ apiVersion: "argoproj.io/v1alpha1", kind: "Application", metadata: { name, namespace: "argocd" }, spec });

  it("gives an Application source a card for the repo and path, and one per entry of sources", () => {
    const out = outsideRefs([
      app("one", { source: { repoURL: "https://GitHub.com/acme/infra.git", path: "./apps/web", targetRevision: "main" } }),
      app("two", { sources: [{ repoURL: "https://charts.example.com", chart: "nginx" }, { repoURL: "https://github.com/acme/infra/", path: "apps/web" }] }),
    ]);
    expect(out.cards.map((c) => c.id)).toEqual(["outside:source:https://charts.example.com#chart=nginx", "outside:source:https://github.com/acme/infra#apps/web"]);
    expect(out.cards[1].attrs).toEqual({ repoURL: "https://github.com/acme/infra", path: "apps/web" });
    expect(out.edges.map((e) => [e.from, e.viaAttr, e.revision])).toEqual([
      ["argoproj.io/Application/argocd/one", "spec.source", "main"],
      ["argoproj.io/Application/argocd/two", "spec.sources[0]", undefined],
      ["argoproj.io/Application/argocd/two", "spec.sources[1]", undefined],
    ]);
  });

  it("notes an Application source with no repoURL", () => {
    const out = outsideRefs([app("x", { source: { path: "a" } })]);
    expect(out.cards).toEqual([]);
    expect(out.notes[0]).toMatchObject({ code: "unrecognised", path: "spec.source.repoURL" });
  });

  it("takes a Kustomization's repo from its source object and its path from spec.path", () => {
    const git = { apiVersion: "source.toolkit.fluxcd.io/v1", kind: "GitRepository", metadata: { name: "fleet", namespace: "flux-system" }, spec: { url: "ssh://git@github.com/acme/fleet.git" } };
    const ks = { apiVersion: "kustomize.toolkit.fluxcd.io/v1", kind: "Kustomization", metadata: { name: "apps", namespace: "flux-system" }, spec: { path: "./clusters/prod", sourceRef: { kind: "GitRepository", name: "fleet" } } };
    const out = outsideRefs([git, ks]);
    expect(out.cards.map((c) => [c.id, c.attrs.sourceKind])).toEqual([["outside:source:ssh://git@github.com/acme/fleet#clusters/prod", "GitRepository"]]);
    expect(out.edges[0]).toMatchObject({ from: "kustomize.toolkit.fluxcd.io/Kustomization/flux-system/apps", viaAttr: "spec.sourceRef" });
  });

  it("notes a Kustomization whose source object was not read", () => {
    const ks = { apiVersion: "kustomize.toolkit.fluxcd.io/v1", kind: "Kustomization", metadata: { name: "apps", namespace: "flux-system" }, spec: { sourceRef: { kind: "GitRepository", name: "fleet" } } };
    expect(outsideRefs([ks]).notes[0]).toMatchObject({ code: "unresolved", path: "spec.sourceRef" });
  });

  it("returns no card for a repo the graph holds", () => {
    const graph = { nodes: [{ id: "g", kind: "github_repository", attrs: { clone_url: "https://github.com/acme/infra.git" } }] };
    expect(outsideRefs([app("one", { source: { repoURL: "https://github.com/acme/infra", path: "x" } })], { graph }).cards).toEqual([]);
  });

  it("normalizes a URL the same whichever way it is written", () => {
    expect(normalizeUrl("https://GitHub.com/acme/infra.git/")).toBe("https://github.com/acme/infra");
    expect(normalizeUrl("git@github.com:acme/infra.git")).toBe("git@github.com:acme/infra");
  });
});

describe("input shapes", () => {
  it("opens a List and skips what it has no rule for", () => {
    const list = { apiVersion: "v1", kind: "List", items: [sa("r", { "eks.amazonaws.com/role-arn": ARN }), { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" } }] };
    expect(outsideRefs([list, null, "x"]).cards).toHaveLength(1);
  });

  it("gives the same answer whatever order the objects arrive in", () => {
    const objs = [GCP_STORE, externalSecret("a", "app", { name: "gcp", kind: "ClusterSecretStore" }, ["k"]), sa("r", { "eks.amazonaws.com/role-arn": ARN })];
    expect(outsideRefs([...objs].reverse())).toEqual(outsideRefs(objs));
  });
});

describe("browser safety", () => {
  it("imports nothing", () => {
    const text = readFileSync(new URL("./outside-refs.js", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect(text).not.toMatch(/(^|\n)\s*import\b/);
    expect(text).not.toMatch(/\brequire\s*\(|\bnode:|\bprocess\./);
  });
});
