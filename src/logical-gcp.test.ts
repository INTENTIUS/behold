import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { projectGcpLogical, declaredProject, GCP_HEADLINE_KINDS } from "./logical-gcp.ts";

const n = (id: string, kind: string, file: string, attrs: Record<string, unknown> = {}) => ({
  id,
  kind,
  lexicon: "gcp",
  attrs,
  sourceLoc: { file },
});

/** Shaped like chant's real GCP IR: `location` is a plain string on the node,
 * and the project rides a CNRM annotation chant emits as an intrinsic. */
function fixture(): GraphIR {
  const NET = "src/platform/cluster.ts";
  const APP = "src/app/app.ts";
  return {
    nodes: [
      n("annotations", "chant:gcp:defaultAnnotations", NET, {
        annotations: { "cnrm.cloud.google.com/project-id": { $intrinsic: true } },
      }),
      n("cluster", "GCP::Container::Cluster", NET, { metadata: { name: "gke" }, location: "us-central1" }),
      n("nodePool", "GCP::Container::NodePool", NET, { location: "us-central1" }),
      n("network", "GCP::Compute::Network", NET, { metadata: { name: "vpc" } }),
      n("subnet", "GCP::Compute::Subnetwork", NET, { ipCidrRange: "10.0.0.0/20", location: "us-central1" }),
      n("gsa", "GCP::Iam::ServiceAccount", NET, { metadata: { name: "sa" } }),
      n("db", "GCP::Sql::Instance", APP, { metadata: { name: "app-db" }, location: "us-central1" }),
      n("bucket", "GCP::Storage::Bucket", APP, { metadata: { name: "assets" }, location: "us-central1" }),
      n("dnsZone", "GCP::Dns::ManagedZone", APP, { metadata: { name: "zone" } }),
    ],
    edges: [],
    groups: {},
  } as unknown as GraphIR;
}

const parentOf = (bc: Record<string, string[]>, id: string) =>
  Object.entries(bc).find(([, ids]) => ids.includes(id))?.[0];

describe("declaredProject", () => {
  it("is undefined when chant emitted the annotation as an intrinsic — the usual case", () => {
    expect(declaredProject(fixture().nodes)).toBeUndefined();
  });

  it("reads a project pinned literally in source", () => {
    const ir = fixture();
    (ir.nodes[0].attrs as Record<string, unknown>).annotations = { "cnrm.cloud.google.com/project-id": "pinned-proj" };
    expect(declaredProject(ir.nodes)).toBe("pinned-proj");
  });
});

describe("projectGcpLogical (#101)", () => {
  const { ir, byContainer } = projectGcpLogical(fixture(), "my-project");

  it("keeps only headline resources — networking, IAM and node pools are not cards", () => {
    expect(ir.nodes.map((x) => x.id).sort()).toEqual(["bucket", "cluster", "db", "dnsZone"]);
  });

  it("nests project -> location, with no network containment at all", () => {
    expect(parentOf(byContainer, "location us-central1")).toBe("project my-project");
    // The estate declares a Subnetwork with a CIDR; #101 settles that GCP gets
    // no subnet boxes, so it must not appear as one.
    expect(Object.keys(byContainer).some((k) => /subnet|CIDR|10\.0\.0\.0/.test(k))).toBe(false);
  });

  it("names the project from the environment when source pins none", () => {
    const { byContainer: noEnv } = projectGcpLogical(fixture());
    expect(Object.keys(noEnv)).toContain("project");
    expect(Object.keys(noEnv)).not.toContain("project my-project");
  });

  it("prefers a project pinned in source over the environment", () => {
    const pinned = fixture();
    (pinned.nodes[0].attrs as Record<string, unknown>).annotations = { "cnrm.cloud.google.com/project-id": "pinned-proj" };
    const { byContainer: bc } = projectGcpLogical(pinned, "my-project");
    expect(Object.keys(bc)).toContain("project pinned-proj");
  });

  it("puts a component whose members share one region inside it", () => {
    const oneRegion = {
      nodes: [
        n("db", "GCP::Sql::Instance", "src/app/a.ts", { location: "europe-west1" }),
        n("bucket", "GCP::Storage::Bucket", "src/app/a.ts", { location: "europe-west1" }),
      ],
      edges: [],
      groups: {},
    } as unknown as GraphIR;
    const { byContainer: bc } = projectGcpLogical(oneRegion, "p");
    expect(parentOf(bc, "app")).toBe("location europe-west1");
  });

  it("lifts a component spanning regions to the project, as the AWS lens does across subnets", () => {
    // `app` holds a regional db/bucket and a global DNS zone.
    expect(parentOf(byContainer, "app")).toBe("project my-project");
  });

  it("gives a resource with no location the global lane rather than a region it is not in", () => {
    const globalOnly = {
      nodes: [n("dnsZone", "GCP::Dns::ManagedZone", "src/app/a.ts", { metadata: { name: "z" } })],
      edges: [],
      groups: {},
    } as unknown as GraphIR;
    const { byContainer: bc } = projectGcpLogical(globalOnly, "p");
    expect(parentOf(bc, "app")).toBe("global");
    expect(parentOf(bc, "global")).toBe("project p");
  });

  it("draws no edge through a shared service account", () => {
    const shared = {
      nodes: [
        n("gsa", "GCP::Iam::ServiceAccount", "src/app/a.ts", { metadata: { name: "sa" } }),
        n("db", "GCP::Sql::Instance", "src/app/a.ts", { location: "us-central1", sa: { $ref: "gsa.name" } }),
        n("bucket", "GCP::Storage::Bucket", "src/app/a.ts", { location: "us-central1", sa: { $ref: "gsa.name" } }),
      ],
      edges: [],
      groups: {},
    } as unknown as GraphIR;
    const { ir: out } = projectGcpLogical(shared, "p");
    expect(out.edges).toHaveLength(0);
  });

  it("leaves a non-GCP graph alone", () => {
    const aws = { nodes: [{ id: "vpc", kind: "AWS::EC2::VPC", lexicon: "aws", attrs: {} }], edges: [], groups: {} } as unknown as GraphIR;
    const out = projectGcpLogical(aws, "p");
    expect(out.ir.nodes).toHaveLength(0);
    expect(out.byContainer).toEqual({});
  });

  it("treats declared-but-unemulated networking as fabric, not as cards", () => {
    // floci-gcp emulates no compute networking, so these are never observed —
    // but chant can express them, and the example declares them.
    for (const kind of ["GCP::Compute::Network", "GCP::Compute::Subnetwork", "GCP::Compute::Firewall"]) {
      expect(GCP_HEADLINE_KINDS.has(kind)).toBe(false);
    }
    expect(ir.nodes.some((x) => x.kind.startsWith("GCP::Compute::"))).toBe(false);
  });
});
