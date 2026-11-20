import { describe, it, expect, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeStacks, type GraphIR } from "@intentius/pinhole";
import { PULUMI_PREVIEW_CHANT_FLOOR } from "./chant-floors.ts";
import { linkDemoPins } from "./demo-pins.ts";
import { meetsFloor } from "./floor.ts";
import { resetMemberIrCache } from "./member-ir.ts";
import { pulumiCardFields, pulumiIconFor, terraformSpellings } from "./pulumi-card.ts";
import { paintPulumiPreview, pulumiPreviewArgs, pulumiPreviewReadOf, PULUMI_OBSERVE_ENV, readPulumiPreview } from "./pulumi-preview.ts";
import { applyReferenceCatalog, referenceCatalogOf } from "./reference-catalog.ts";
import { createApp } from "./server.ts";
import { localServeOptions } from "./shot-cli.ts";
import { choudoufuCardFields } from "./choudoufu-card.ts";
import { planCardRows, terraformCardFields } from "./terraform-lens.ts";
import { resolvedVersion } from "./terraform-member.ts";
import { memberIrFromGraphDocument, setServedWorkspace } from "./workspace.ts";
import type { WorkspaceDocument } from "./workspace-reader.ts";

// behold#1227: a Pulumi member draws what a Terraform root draws. Provenance:
//  - e2e/fixtures/pulumi-stacks: three pulumi members. `network` and `app` are
//    chant's testdata/three-cloud-aws export split in two, `app` on plunge
//    with an engine-graph.json and a StackReference to `network/dev`; `edge`
//    has no export.
//  - __fixtures__/pulumi-stacks/*.json: `chant workspace graph` run in that
//    fixture, unedited, by chant origin/main at d86a73b0d packed as 0.124.110
//    (the lexicons as 0.124.103). workspace-graph.json is the whole
//    workspace's source read; preview-<member>.json is `--member <member>
//    --live --overlay --env behold-plan --detail 3` with
//    CHANT_PULUMI_OBSERVE=preview and engine/engine.js on PATH as `pulumi`
//    and `plunge`, printing engine/previews/<member>.json;
//    preview-app-no-binary.json is the same with neither on PATH.
const FIX = join(import.meta.dirname, "__fixtures__", "pulumi-stacks");
const doc = (name: string): WorkspaceDocument => JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8")) as WorkspaceDocument;
const MEMBERS = ["network", "app", "edge"];

/** The estate as behold composes it: each member's own part of the document, then the whole read's catalog. */
function estate(): GraphIR {
  const whole = doc("workspace-graph");
  const ir = composeStacks(MEMBERS.map((name) => ({ name, ir: memberIrFromGraphDocument(whole, name) as never }))) as GraphIR;
  return applyReferenceCatalog(ir as never, referenceCatalogOf(whole)!) as unknown as GraphIR;
}

const APP_STACK = "app/pulumi:pulumi:Stack";
const NETWORK_STACK = "network/pulumi:pulumi:Stack";
const SERVICE = "app/app/aws:ecs/service:Service::web";
const BUCKET = "app/app/aws:s3/bucketV2:BucketV2::assets";

describe("a member's read keeps only its own edges (behold#1227)", () => {
  it("leaves out the StackReference edge that lands in another member", () => {
    const app = memberIrFromGraphDocument(doc("workspace-graph"), "app");
    const ids = new Set(app.nodes.map((n) => n.id));
    expect(app.edges.length).toBeGreaterThan(0);
    for (const e of app.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  });
});

describe("catalog and StackReference edges from chant (behold#1227)", () => {
  it("draws the pulumi catalog's edges, inside a member and across two", () => {
    const ir = estate();
    const derived = ir.edges.filter((e) => (e as { origin?: string }).origin === "derived").map((e) => `${e.from} -> ${e.to}`);
    expect(derived).toContain(`${SERVICE} -> app/app/aws:ecs/cluster:Cluster::cluster`);
    expect(derived).toContain(`${SERVICE} -> network/network/aws:ec2/subnet:Subnet::private-1`);
    expect(derived).toContain(`${SERVICE} -> network/network/aws:ec2/securityGroup:SecurityGroup::service`);
  });

  it("draws one edge per output a StackReference reads, from the reader's stack to the stack the other member applies", () => {
    const ir = estate();
    const reads = ir.edges.filter((e) => e.from === APP_STACK && e.to === NETWORK_STACK);
    expect(reads.map((e) => e.viaAttr).sort()).toEqual(["subnetId", "vpcId"]);
    expect(reads.every((e) => (e as { origin?: string }).origin === "declared")).toBe(true);
    // Every edge ends at a node the estate draws.
    const ids = new Set(ir.nodes.map((n) => n.id));
    for (const e of ir.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  });

  it("reads the reads off the whole workspace's document with the composed ids", () => {
    expect(referenceCatalogOf(doc("workspace-graph"))!.reads).toEqual([
      { from: APP_STACK, to: NETWORK_STACK, kind: "ref", viaAttr: "subnetId" },
      { from: APP_STACK, to: NETWORK_STACK, kind: "ref", viaAttr: "vpcId" },
    ]);
  });
});

describe("the pulumi card pack (behold#1227)", () => {
  it("spells a provider token as the Terraform type names it", () => {
    expect(terraformSpellings("aws:ec2/vpc:Vpc")).toEqual(["aws_ec2_vpc", "aws_vpc", "aws_ec2"]);
    expect(terraformSpellings("gcp:storage/bucket:Bucket")[0]).toBe("google_storage_bucket");
    expect(terraformSpellings("azure-native:app:ContainerApp")).toContain("azurerm_container_app");
    expect(terraformSpellings("random:index/randomId:RandomId")).toEqual([]);
  });

  it("gives a resource the icon its Terraform type wears, and a Kubernetes kind its own", () => {
    for (const kind of ["aws:ec2/vpc:Vpc", "aws:s3/bucketV2:BucketV2", "aws:ecs/service:Service", "aws:iam/role:Role", "gcp:storage/bucket:Bucket", "azure-native:app:ContainerApp", "kubernetes:apps/v1:Deployment"]) {
      expect(pulumiIconFor(kind), kind).toBeDefined();
    }
    expect(pulumiIconFor("random:index/randomId:RandomId")).toBeUndefined();
    expect(pulumiIconFor("not a token")).toBeUndefined();
  });

  it("shows chant's ownership word from a plunge member's engine facts", () => {
    const ir = estate();
    const card = (id: string) => pulumiCardFields(ir.nodes.find((n) => n.id === id)! as never);
    expect(card(SERVICE)).toEqual([{ label: "ownership", value: "bound" }]);
    expect(card(BUCKET)).toEqual([{ label: "ownership", value: "pending" }]);
    // A stock member's resource carries no facts, so it has no ownership row.
    expect(card("network/network/aws:ec2/vpc:Vpc::network-vpc")).toBeUndefined();
  });

  it("shows the same word on a choudoufu roster card and a Terraform block that carry chant's facts", () => {
    const facts = { ownership: "foreign" };
    expect(choudoufuCardFields({ attrs: { estate: "e" }, facts } as never, { boxEstate: "e" })).toEqual([{ label: "ownership", value: "foreign" }]);
    expect(terraformCardFields({ attrs: { block: "resource", root: "azure" }, facts } as never)).toEqual([
      { label: "ownership", value: "foreign" },
      { label: "root", value: "azure" },
    ]);
    expect(choudoufuCardFields({ attrs: { estate: "e", rung: "record-only" } }, { boxEstate: "e" })).toEqual([{ label: "rung", value: "record-only" }]);
  });

  it("names the stack a StackReference reads and the stack a stack node stands for", () => {
    const ir = estate();
    expect(pulumiCardFields(ir.nodes.find((n) => n.id === "app/app/pulumi:pulumi:StackReference::network/dev")! as never)).toEqual([{ label: "reads", value: "network/dev" }]);
    expect(pulumiCardFields(ir.nodes.find((n) => n.id === NETWORK_STACK)! as never)).toEqual([{ label: "stack", value: "dev" }]);
  });
});

describe("the plan read on a Pulumi member (behold#1227)", () => {
  it("asks chant's workspace graph for the member at the preview depth", async () => {
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    const res = await readPulumiPreview({ name: "app" }, "/ws", {
      chantVersion: () => "0.124.110",
      read: async (_root, args, env) => {
        calls.push({ args, env });
        return doc("preview-app");
      },
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ args: ["/ws", "--member", "app", "--env", "behold-plan", "--live", "--overlay", "--detail", "3"], env: { [PULUMI_OBSERVE_ENV]: "preview" } }]);
    expect(pulumiPreviewArgs("/ws", "app")).toEqual(calls[0]!.args);
  });

  it("refuses below the floor before anything is read", async () => {
    let read = false;
    const res = await readPulumiPreview({ name: "app" }, "/ws", { chantVersion: () => "0.124.107", read: async () => ((read = true), doc("preview-app")) });
    expect(res).toMatchObject({ ok: false, refusal: { code: "chant-too-old" } });
    expect(read).toBe(false);
  });

  it("puts the preview's action, replace reason and changes on each card", () => {
    const read = pulumiPreviewReadOf(doc("preview-app"), "app");
    expect(read.roots).toEqual([{ root: "app", answered: "plan", note: "pulumi.members.app: the preview read answered" }]);
    expect(read.cards["app/aws:ecs/service:Service::web"]).toMatchObject({ source: "plan", action: "update", changes: [{ path: "desiredCount", before: null, after: 3 }] });
    expect(read.cards["app/aws:s3/bucketV2:BucketV2::assets"]).toMatchObject({ source: "plan", action: "replace", replacePaths: ["bucket"] });
    expect(read.cards["app/aws:ecs/cluster:Cluster::cluster"]).toMatchObject({ action: "no-op" });

    const ir = estate();
    expect(paintPulumiPreview(ir, read, "app")).toBeGreaterThan(0);
    const bucket = ir.nodes.find((n) => n.id === BUCKET)!;
    expect(planCardRows(bucket.attrs._plan)).toEqual([
      { label: "plan", value: "replace" },
      { label: "forced by", value: "bucket three-cloud-assets -> three-cloud-assets-v2" },
      { label: "read", value: "plan" },
    ]);
    expect(pulumiCardFields(bucket as never)).toEqual([...planCardRows(bucket.attrs._plan), { label: "ownership", value: "pending" }]);
  });

  it("draws a stack with no export from its preview", () => {
    const ir = estate();
    expect(ir.nodes.filter((n) => n.id.startsWith("edge/"))).toEqual([]);
    const read = pulumiPreviewReadOf(doc("preview-edge"), "edge");
    expect(paintPulumiPreview(ir, read, "edge")).toBe(2);
    const edge = ir.nodes.filter((n) => n.id.startsWith("edge/"));
    expect(edge.map((n) => n.id).sort()).toEqual(["edge/edge/aws:sns/topic:Topic::alerts", "edge/edge/aws:sqs/queue:Queue::events"]);
    for (const n of edge) {
      expect(n.attrs._plan).toMatchObject({ source: "plan", action: "create" });
      // The source picture: chant's live colour is not carried.
      expect(n.attrs._status).toBeUndefined();
    }
    expect((ir.groups.byStack as Record<string, string[]>).edge.sort()).toEqual(edge.map((n) => n.id).sort());
  });

  it("says the plan was not read, and why, when the engine is missing", () => {
    const read = pulumiPreviewReadOf(doc("preview-app-no-binary"), "app");
    expect(read.roots).toEqual([
      { root: "app", answered: "none", reason: "no-binary", note: "pulumi.members.app: no read answered, declared only: the preview read failed (the engine binary is not on PATH)" },
    ]);
    const card = read.cards["app/aws:ecs/service:Service::web"]!;
    expect(card).toMatchObject({ source: "none", readReason: "no-binary" });
    expect(planCardRows(card)).toEqual([
      { label: "plan", value: "not read" },
      { label: "read", value: "none, declared only" },
    ]);
  });
});

// Through the real chant installed beside behold, on a copy of the fixture re-pinned at the installed lexicon.
const PULUMI_LEXICON_PKG = "@intentius/chant-lexicon-pulumi";
const INSTALLED = resolvedVersion(PULUMI_LEXICON_PKG);
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const gate = !INSTALLED && !REQUIRE_PEERS;
const COPY = gate ? "" : mkdtempSync(join(tmpdir(), "behold-pulumi-stacks-"));
afterAll(() => {
  if (COPY) rmSync(COPY, { recursive: true, force: true });
  setServedWorkspace(undefined);
  resetMemberIrCache();
});

describe("a Pulumi workspace served through the real chant (behold#1227)", () => {
  it.skipIf(gate)("draws the StackReference between two members, and asks the preview with ?plan=1", { timeout: 180_000 }, async () => {
    cpSync(join(import.meta.dirname, "..", "e2e", "fixtures", "pulumi-stacks"), COPY, { recursive: true });
    const pins = linkDemoPins(COPY);
    if (!pins.ok) throw new Error(`${pins.error} ${pins.remedy}`);
    resetMemberIrCache();
    const cfg = await localServeOptions(COPY);
    const asked: string[] = [];
    const app = createApp({ ...cfg, pulumiPreview: { chantVersion: () => "0.124.110", read: async (_r, args) => (asked.push(args[2]!), doc(`preview-${args[2]}`)) } });
    const body = (await (await app.request("http://localhost/api/graph")).json()) as { error?: string; ir: GraphIR };
    expect(body.error).toBeUndefined();
    const ws = (await import("./workspace.ts")).servedWorkspace();
    // The edges come from a chant at the floor; the published one draws the members without them.
    const chantNew = meetsFloor(ws?.chant ?? "0.0.0", PULUMI_PREVIEW_CHANT_FLOOR);
    if (chantNew) {
      expect(body.ir.edges.filter((e) => e.from === APP_STACK && e.to === NETWORK_STACK).map((e) => e.viaAttr).sort()).toEqual(["subnetId", "vpcId"]);
    }
    const plan = (await (await app.request("http://localhost/api/graph?plan=1")).json()) as { ir: GraphIR };
    expect(asked.sort()).toEqual([...MEMBERS].sort());
    const svc = plan.ir.nodes.find((n) => n.id === SERVICE);
    if (chantNew) expect(svc?.attrs._plan).toMatchObject({ action: "update" });
    expect(plan.ir.nodes.some((n) => n.id === "edge/edge/aws:sqs/queue:Queue::events")).toBe(true);
  });
});
