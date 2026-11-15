import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cutAround, findK8sNode, identityOf, neighbourhoodOf } from "./neighbourhood.js";

const k8s = (id, kind, apiVersion, name, namespace) => ({
  id,
  kind,
  lexicon: "k8s",
  attrs: { apiVersion, kind: kind.split("::").pop(), metadata: { name, ...(namespace ? { namespace } : {}) } },
});
const tf = (id, kind) => ({ id, kind, lexicon: "terraform", attrs: {} });
const edge = (from, to) => ({ from, to });

/** Deployment web -> ServiceAccount runner -> google_service_account -> project, plus a second Deployment on the same account. */
function fixture() {
  return {
    nodes: [
      k8s("web", "K8s::Apps::Deployment", "apps/v1", "web"),
      k8s("runner", "K8s::Core::ServiceAccount", "v1", "runner"),
      k8s("other", "K8s::Apps::Deployment", "apps/v1", "other"),
      tf("gsa", "google_service_account"),
      tf("project", "google_project"),
      tf("bucket", "google_storage_bucket"),
    ],
    edges: [edge("web", "runner"), edge("other", "runner"), edge("runner", "gsa"), edge("gsa", "project"), edge("bucket", "project")],
    groups: { byStack: { cluster: ["web", "runner", "other"], cloud: ["gsa", "project", "bucket"] } },
  };
}
const ids = (cut) => cut.nodes.map((n) => n.id).sort();

describe("neighbourhoodOf", () => {
  it("keeps the Deployment, the account, the cloud identity and the project at outside 2", () => {
    const cut = neighbourhoodOf(fixture(), { group: "apps", kind: "Deployment", name: "web" }, { depth: 1, outside: 2 });
    expect(ids(cut)).toEqual(["gsa", "project", "runner", "web"]);
    expect(cut.edges).toHaveLength(3);
    expect(cut.seeds).toEqual(["web"]);
    expect(cut.groups).toEqual({ byStack: { cluster: ["web", "runner"], cloud: ["gsa", "project"] } });
  });

  it("keeps the Deployment and the account only at outside 0", () => {
    const cut = neighbourhoodOf(fixture(), { group: "apps", kind: "Deployment", name: "web" }, { depth: 1, outside: 0 });
    expect(ids(cut)).toEqual(["runner", "web"]);
    expect(cut.edges).toEqual([edge("web", "runner")]);
  });

  it("counts outside hops from the last Kubernetes node", () => {
    const cut = neighbourhoodOf(fixture(), { group: "apps", kind: "Deployment", name: "web" }, { depth: 1, outside: 1 });
    expect(ids(cut)).toEqual(["gsa", "runner", "web"]);
  });

  it("does not take a sibling that shares a dependency", () => {
    const cut = neighbourhoodOf(fixture(), { group: "apps", kind: "Deployment", name: "web" }, { depth: 3 });
    expect(ids(cut)).not.toContain("other");
    expect(ids(cut)).not.toContain("bucket");
  });

  it("walks down from the account to what uses it", () => {
    const cut = neighbourhoodOf(fixture(), { kind: "ServiceAccount", name: "runner" }, { depth: 1, up: false });
    expect(ids(cut)).toEqual(["other", "runner", "web"]);
  });

  it("returns no nodes and a reason naming an identity that is not there", () => {
    const cut = neighbourhoodOf(fixture(), { group: "apps", kind: "Deployment", namespace: "prod", name: "absent" });
    expect(cut.nodes).toEqual([]);
    expect(cut.edges).toEqual([]);
    expect(cut.reason).toContain("apps/Deployment prod/absent");
  });
});

describe("findK8sNode", () => {
  it("joins an object with no namespace to default, and matches a cluster-scoped kind without one", () => {
    const g = {
      nodes: [
        k8s("a", "K8s::Apps::Deployment", "apps/v1", "web", "default"),
        k8s("b", "K8s::Apps::Deployment", "apps/v1", "web", "prod"),
        k8s("ns", "K8s::Core::Namespace", "v1", "prod"),
      ],
      edges: [],
      groups: {},
    };
    expect(findK8sNode(g, { group: "apps", kind: "Deployment", name: "web" }).id).toBe("a");
    expect(findK8sNode(g, { group: "apps", kind: "Deployment", namespace: "prod", name: "web" }).id).toBe("b");
    expect(findK8sNode(g, { group: "", kind: "Namespace", name: "prod" }).id).toBe("ns");
    expect(findK8sNode(g, { group: "batch", kind: "Deployment", name: "web" })).toBeNull();
  });

  it("reads the group from the IR kind when the node carries no apiVersion", () => {
    const g = { nodes: [{ id: "d", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: { metadata: { name: "web" } } }], edges: [], groups: {} };
    expect(identityOf(g.nodes[0])).toMatchObject({ group: "apps", kind: "Deployment", name: "web" });
    expect(findK8sNode(g, { group: "apps", kind: "Deployment", name: "web" }).id).toBe("d");
  });
});

describe("cutAround", () => {
  const chain = () => ({ nodes: ["a", "b", "c"].map((id) => tf(id, "t")), edges: [edge("a", "b"), edge("b", "c")], groups: {} });

  it("up keeps what the seed needs and down keeps what needs it", () => {
    expect(ids(cutAround(chain(), ["b"], { depth: 5, down: false }))).toEqual(["b", "c"]);
    expect(ids(cutAround(chain(), ["b"], { depth: 5, up: false }))).toEqual(["a", "b"]);
  });

  it("bounds the walk by depth over a graph with no inside predicate", () => {
    expect(ids(cutAround(chain(), ["a"], { depth: 1 }))).toEqual(["a", "b"]);
    expect(ids(cutAround(chain(), ["a"], { depth: 2 }))).toEqual(["a", "b", "c"]);
  });

  it("names the ids it could not find", () => {
    const cut = cutAround(chain(), ["a", "zz"], { depth: 1 });
    expect(cut.missing).toEqual(["zz"]);
    expect(cutAround(chain(), ["zz"]).reason).toContain("zz");
  });
});

describe("module graph", () => {
  it("imports nothing from node: and nothing outside web/", () => {
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
        const spec = m[1] || m[2] || m[3];
        expect(spec.startsWith("./"), `${file} imports ${spec}`).toBe(true);
        walk(resolve(dirname(file), spec));
      }
    };
    walk(join(import.meta.dirname, "neighbourhood.js"));
    expect([...seen].map((f) => f.split("/").pop()).sort()).toEqual(["cut-around.js", "neighbourhood.js"]);
  });
});
