// behold#995: every member kind colours from chant's drift record.
//
// End to end from the read to the card, with chant answered from documents
// in the shape `chant workspace drift --member <name>` prints (contract 1,
// `drift: "v1"`, chant#4451): the real workspace reader over a transport that
// records each argv, the real document check, the alias table for the
// choudoufu member, and the one (status, read) table. A chant, a choudoufu,
// a plain Terraform and a Pulumi member are read in one pass, and no code
// path in between names the engine.
import { describe, expect, it } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { cardIdFor, choudoufuCardAliases, driftDocumentOf, DRIFT_DEFAULT_KINDS, DRIFT_KINDS, paintDrift, paintWorkspaceDrift } from "./drift-overlay.ts";
import { workspaceReader } from "./workspace-reader.ts";
import type { WorkspaceMember } from "./workspace.ts";

const AT = "2026-10-25T09:00:00Z";
const rec = (member: string, engine: string, address: string, node: string | null, read: string, status: string, extra: Record<string, unknown> = {}) => ({
  member,
  engine,
  address,
  node,
  observedAt: AT,
  read,
  status,
  evidence: { tool: engine },
  ...extra,
});
const doc = (member: string, records: unknown[], error?: { code: string; message: string }) => ({
  $schema: "https://intentius.io/chant/schemas/workspace/drift/v1/drift.schema.json",
  drift: "v1",
  contract: 1,
  chant: "0.124.53",
  member,
  records,
  counts: {},
  ...(error ? { error } : {}),
});

const DOCS: Record<string, unknown> = {
  dns: doc("dns", [rec("dns", "chant", "zone", "dns/zone", "live-read", "in-sync"), rec("dns", "chant", "record", "dns/record", "live-read", "drifted", { attributes: [{ path: "ttl" }] })]),
  tf: doc("tf", [
    rec("tf", "terraform", "aws_s3_bucket.logs", "tf/tf/aws_s3_bucket.logs", "state", "recorded"),
    rec("tf", "terraform", "aws_s3_bucket.new", "tf/tf/aws_s3_bucket.new", "state", "pending"),
  ]),
  azure: doc("azure", [
    rec("azure", "choudoufu", 'module.site["a"].azurerm_storage_account.sa', "azure/azure/module.site/azurerm_storage_account.sa", "plan", "drifted", { ownership: { verdict: "owned", by: "marker" } }),
    // chant's ruling: an UNOWNED omission with no unowned[] row is not-observed.
    rec("azure", "choudoufu", "azurerm_resource_group.rg", "azure/azure/azurerm_resource_group.rg", "ownership", "not-observed", { unobserved: { reason: "read-failed" }, evidence: { tool: "choudoufu", engineCode: "UNOWNED" } }),
  ]),
  // A Pulumi member (path 2): node null until chant's URN rule exists, and a status this behold does not know.
  aws: doc("aws", [rec("aws", "pulumi", "urn:pulumi:prod::site::aws:s3/bucket:Bucket::site", null, "refresh", "quarantined")]),
};

const nodes = (ids: string[]): GraphIR["nodes"] => ids.map((id) => ({ id, kind: "x", lexicon: "x", attrs: {} }) as GraphIR["nodes"][number]);
const ir = (): Pick<GraphIR, "nodes"> => ({
  nodes: nodes([
    "dns/zone",
    "dns/record",
    "tf/tf/aws_s3_bucket.logs",
    "tf/tf/aws_s3_bucket.new",
    // behold's choudoufu card ids are the roster's, `<member>/<address>`.
    'azure/module.site["a"].azurerm_storage_account.sa',
    'azure/module.site["b"].azurerm_storage_account.sa',
    "azure/azurerm_resource_group.rg",
    "aws/urn:pulumi:prod::site::aws:s3/bucket:Bucket::site",
  ]),
});

/** chant's graph of the choudoufu member: one node per block, `<root>/<block path>`. */
const AZURE_BLOCKS = { nodes: nodes(["azure/module.site/azurerm_storage_account.sa", "azure/azurerm_resource_group.rg"]).map((n) => ({ ...n, attrs: { root: "azure" } })) };

const member = (name: string, kind: string): WorkspaceMember => ({ name, dir: name, kind, abs: `/ws/${name}`, reason: null, because: null });
const WS = { members: [member("dns", "chant"), member("tf", "terraform"), member("azure", "choudoufu"), member("aws", "pulumi"), member("docs", "other")] };

function reader(seen: string[][]) {
  return workspaceReader({
    async run(argv) {
      seen.push(argv);
      const m = argv[argv.indexOf("--member") + 1]!;
      return { status: 0, stdout: JSON.stringify(DOCS[m]), stderr: "" };
    },
  });
}

describe("each member kind colours from the record (behold#995)", () => {
  it("chant, choudoufu, plain Terraform and Pulumi members, in one pass, through the one table", async () => {
    const seen: string[][] = [];
    const g = ir();
    const out = await paintWorkspaceDrift(g, WS, { env: "prod", kinds: DRIFT_KINDS }, { reader: reader(seen), blockGraph: async () => AZURE_BLOCKS });
    const at = (id: string) => g.nodes.find((n) => n.id === id)!.attrs as Record<string, unknown>;

    // One read per member, of the contract command, through the reader. A chant member gets --env.
    expect(seen.map((a) => a.join(" ")).sort()).toEqual([
      "workspace drift --member aws",
      "workspace drift --member azure",
      "workspace drift --member dns --env prod",
      "workspace drift --member tf",
    ]);
    // `other` has no drift read and is not asked.
    expect(out.map((m) => m.member).sort()).toEqual(["aws", "azure", "dns", "tf"]);

    // chant: live-read.
    expect(at("dns/zone")._status).toBe("good");
    expect(at("dns/record")._status).toBe("warn");
    // plain Terraform: a state read is never green.
    expect(at("tf/tf/aws_s3_bucket.logs")._status).toBe("neutral");
    expect((at("tf/tf/aws_s3_bucket.logs")._drift as { label: string }).label).toBe("recorded (state only, not a live read)");
    expect(at("tf/tf/aws_s3_bucket.new")._status).toBe("accent");
    // choudoufu: chant's node lands on behold's card through the alias table, by the record's address.
    expect(at('azure/module.site["a"].azurerm_storage_account.sa')._status).toBe("warn");
    expect(at('azure/module.site["b"].azurerm_storage_account.sa')._status).toBeUndefined();
    expect(at("azure/azurerm_resource_group.rg")._status).toBe("neutral");
    expect((at("azure/azurerm_resource_group.rg")._drift as { engineCode: string }).engineCode).toBe("UNOWNED");
    // Pulumi: no node yet, so the card by address; a status behold does not know is neutral and labelled unknown.
    const pulumi = at("aws/urn:pulumi:prod::site::aws:s3/bucket:Bucket::site");
    expect(pulumi._status).toBe("neutral");
    expect(pulumi._drift).toMatchObject({ status: "quarantined", unknown: true, label: 'unknown status "quarantined"' });
  });

  it("by default only the members with no live half of their own are read from the record", async () => {
    const seen: string[][] = [];
    await paintWorkspaceDrift(ir(), WS, { env: "prod", kinds: DRIFT_DEFAULT_KINDS }, { reader: reader(seen), blockGraph: async () => AZURE_BLOCKS });
    expect(seen.map((a) => a[3]).sort()).toEqual(["aws", "tf"]);
  });

  it("a plan overlay asks the members with a plan read for it", async () => {
    const seen: string[][] = [];
    await paintWorkspaceDrift(ir(), WS, { env: "prod", plan: true, kinds: DRIFT_KINDS }, { reader: reader(seen), blockGraph: async () => AZURE_BLOCKS });
    expect(seen.map((a) => a.join(" ")).filter((a) => a.includes("--read")).sort()).toEqual(["workspace drift --member azure --read plan", "workspace drift --member tf --read plan"]);
  });

  it("chant's error document paints nothing and says why", async () => {
    const r = workspaceReader({ async run() { return { status: 1, stdout: JSON.stringify(doc("tf", [], { code: "command-failed", message: "terraform show failed" })), stderr: "" }; } });
    const g = ir();
    const [tf] = await paintWorkspaceDrift(g, { members: [member("tf", "terraform")] }, { kinds: DRIFT_KINDS }, { reader: r, blockGraph: async () => ({ nodes: [] }) });
    expect(tf).toMatchObject({ member: "tf", painted: 0, error: { code: "command-failed" } });
    expect(g.nodes.every((n) => n.attrs._status === undefined)).toBe(true);
  });
});

describe("the alias table (B3 follow-up, behold#995)", () => {
  it("maps chant's <member>/<root>/<path> onto the roster card the address names, and only an instance of that block", () => {
    const aliases = choudoufuCardAliases("azure", AZURE_BLOCKS);
    expect(aliases.blocks.get("azure/azure/module.site/azurerm_storage_account.sa")).toBe("module.site/azurerm_storage_account.sa");
    expect(cardIdFor(aliases, "azure/azure/module.site/azurerm_storage_account.sa", 'module.site["b"].azurerm_storage_account.sa')).toBe('azure/module.site["b"].azurerm_storage_account.sa');
    expect(cardIdFor(aliases, "azure/azure/module.site/azurerm_storage_account.sa", "azurerm_resource_group.rg")).toBeUndefined();
    expect(cardIdFor(aliases, "azure/azure/nope", "azurerm_resource_group.rg")).toBeUndefined();
    expect(cardIdFor(aliases, null, "azurerm_resource_group.rg")).toBeUndefined();
  });

  it("a C4 instance node maps to its block's path", () => {
    const blocks = { nodes: [{ id: "azure/aws_eip.pool[0]", kind: "x", lexicon: "x", attrs: { root: "azure", instanceOf: "azure/aws_eip.pool" } }] as unknown as GraphIR["nodes"] };
    const aliases = choudoufuCardAliases("azure", blocks);
    expect(cardIdFor(aliases, "azure/azure/aws_eip.pool[0]", "aws_eip.pool[0]")).toBe("azure/aws_eip.pool[0]");
  });
});

describe("the document and the paint", () => {
  it("keeps records the stream decoder accepts and lists the rest", () => {
    const read = driftDocumentOf({ records: [rec("tf", "terraform", "a.b", null, "state", "recorded"), { address: "x" }] });
    expect(read.records).toHaveLength(1);
    expect(read.skipped).toHaveLength(1);
  });

  it("two records on one card: chant's rollup order decides, and a record with no card is listed", () => {
    const g = { nodes: nodes(["tf/tf/aws_eip.pool"]) };
    const r = driftDocumentOf({
      records: [
        rec("tf", "terraform", "aws_eip.pool[0]", null, "plan", "in-sync", { instanceOf: "tf/tf/aws_eip.pool" }),
        rec("tf", "terraform", "aws_eip.pool[1]", "tf/tf/aws_eip.pool[1]", "plan", "drifted", { instanceOf: "tf/tf/aws_eip.pool" }),
        rec("tf", "terraform", "aws_s3_bucket.gone", "tf/tf/aws_s3_bucket.gone", "plan", "missing"),
      ],
    });
    const paint = paintDrift(g, "tf", r.records);
    expect(g.nodes[0]!.attrs._status).toBe("warn");
    expect(paint.painted).toBe(1);
    expect(paint.unplaced).toEqual(["aws_s3_bucket.gone (tf/tf/aws_s3_bucket.gone)"]);
  });
});
