import { describe, expect, it } from "vitest";
import { cloneFor, gitOpsSources, repoKey } from "./gitops-source.ts";

// behold#1123: where a GitOps source's manifests are, and which local clone holds them.

describe("repoKey", () => {
  it("names one repository by its https, ssh and scp forms", () => {
    const key = repoKey("https://github.com/Org/repo");
    expect(repoKey("https://github.com/Org/repo.git")).toBe(key);
    expect(repoKey("ssh://git@github.com/Org/repo.git")).toBe(key);
    expect(repoKey("git@github.com:Org/repo.git")).toBe(key);
    expect(repoKey("https://GitHub.com/Org/repo/")).toBe(key);
    expect(repoKey("https://github.com/org/repo")).not.toBe(key);
  });

  it("names a local repository by its absolute path, as a file URL or a path", () => {
    expect(repoKey("file:///srv/git/deploy/")).toBe("file:/srv/git/deploy");
    expect(repoKey("/srv/git/deploy")).toBe("file:/srv/git/deploy");
  });
});

describe("cloneFor", () => {
  const remotes = (dir: string) => (dir === "/work/deploy" ? ["git@git.example.test:team/deploy.git"] : []);

  it("takes a clone whose remote or own path is the repository, and one named for the URL", () => {
    expect(cloneFor("https://git.example.test/team/deploy", [{ dir: "/work/other" }, { dir: "/work/deploy" }], remotes)).toBe("/work/deploy");
    expect(cloneFor("file:///work/other", [{ dir: "/work/other" }], remotes)).toBe("/work/other");
    expect(cloneFor("https://git.example.test/team/x", [{ url: "https://git.example.test/team/x.git", dir: "/work/x" }], remotes)).toBe("/work/x");
  });

  it("answers undefined when no clone holds the repository", () => {
    expect(cloneFor("https://git.example.test/team/none", [{ dir: "/work/deploy" }], remotes)).toBeUndefined();
  });
});

describe("gitOpsSources", () => {
  const ks = (path: unknown, sourceRef: Record<string, unknown>) => ({
    id: "flux-system/Kustomization/apps",
    kind: "kustomize.toolkit.fluxcd.io/v1/Kustomization",
    listedType: "kustomize.toolkit.fluxcd.io/v1/Kustomization",
    attrs: { metadata: { name: "apps", namespace: "flux-system" }, spec: { ...(path === undefined ? {} : { path }), sourceRef } },
  });
  const gitRepository = (namespace: string) => ({
    id: `${namespace}/GitRepository/deploy`,
    kind: "source.toolkit.fluxcd.io/v1/GitRepository",
    listedType: "source.toolkit.fluxcd.io/v1/GitRepository",
    attrs: { metadata: { name: "deploy", namespace }, spec: { url: "https://git.example.test/team/deploy", ref: { tag: "v1.2.0" } } },
  });

  it("reads a Kustomization's path in the GitRepository of its namespace, the root when it names none", () => {
    expect(gitOpsSources([ks("./clusters/prod/", { kind: "GitRepository", name: "deploy" }), gitRepository("flux-system")])).toEqual([
      { app: "flux-system/Kustomization/apps", via: "Kustomization", name: "apps", repo: "https://git.example.test/team/deploy", path: "clusters/prod", revision: "v1.2.0" },
    ]);
    expect(gitOpsSources([ks(undefined, { kind: "GitRepository", name: "deploy" }), gitRepository("flux-system")])[0]?.path).toBe("");
  });

  it("follows a sourceRef into another namespace, and reads no OCIRepository or path that climbs out", () => {
    expect(gitOpsSources([ks("apps", { kind: "GitRepository", name: "deploy", namespace: "shared" }), gitRepository("shared")])).toHaveLength(1);
    expect(gitOpsSources([ks("apps", { kind: "GitRepository", name: "deploy" }), gitRepository("shared")])).toHaveLength(0);
    expect(gitOpsSources([ks("apps", { kind: "OCIRepository", name: "deploy" }), gitRepository("flux-system")])).toHaveLength(0);
    expect(gitOpsSources([ks("../up", { kind: "GitRepository", name: "deploy" }), gitRepository("flux-system")])).toHaveLength(0);
  });

  it("reads an Application through the catalog's path rules, directories only", () => {
    const app = { id: "argocd/Application/web", kind: "K8s::Argo::Application", attrs: { metadata: { name: "web" }, spec: { source: { repoURL: "https://git.example.test/team/deploy", path: "web", targetRevision: "HEAD" } } } };
    const rules = [
      { from: "K8s::Argo::Application", path: "spec.source.path", read: () => [{ value: "web", repo: "https://git.example.test/team/deploy", type: "dir" as const }] },
      { from: "K8s::Argo::Application", path: "spec.source.helm.valueFiles[]", read: () => [{ value: "web/values.yaml", repo: "https://git.example.test/team/deploy", type: "file" as const }] },
    ];
    expect(gitOpsSources([app], rules)).toEqual([{ app: "argocd/Application/web", via: "Application", name: "web", repo: "https://git.example.test/team/deploy", path: "web", revision: "HEAD" }]);
    expect(gitOpsSources([app])).toEqual([]);
  });
});
