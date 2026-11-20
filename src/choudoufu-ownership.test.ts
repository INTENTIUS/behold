import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeStacks } from "@intentius/pinhole";
import type { GraphIR, IRNode } from "@intentius/chant";
import { addChoudoufuReferenceEdges, liveCheckToIr, parseLiveCheck, type LiveCheckDocument } from "./choudoufu-member.ts";
import { choudoufuDiffNodes } from "./choudoufu-live.ts";
import { adoptLine, instanceAddressOf, MARKER_NONE, MARKER_ON, ownershipVerdictOf, paintChoudoufuOwnership } from "./choudoufu-ownership.ts";
import { choudoufuCardFields } from "./choudoufu-card.ts";
import { estateBoxTitle, projectChoudoufuLogical } from "./logical-choudoufu.ts";

// behold#1227: a choudoufu member's cards are painted from chant's live read,
// `facts.ownership` and `facts.ownershipRows` on each instance node
// (INTENTIUS/chant#5333, #5402). The rosters and the choudoufu documents are
// the #370 recordings: printed by a choudoufu built from main at 9c7d3701e2
// against a scratch floci with the live-mv workbench's tlmig-sample-monolith
// applied, nothing hand-edited (clean; then an untagged log group declared and
// a block renamed; then the team-a split). chant's terraform lexicon builds
// the rows from those same documents; `liveIr` below writes them the way
// chant prints them, so each case is the read chant gives for that recording.
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (name: string): string => readFileSync(join(HERE, "__fixtures__", name), "utf8");
const check = (name: string): LiveCheckDocument => {
  const p = parseLiveCheck(JSON.parse(raw(name)));
  if (!p.ok) throw new Error(p.refusal.error);
  return p.doc;
};
const ROOT = "estate";

type Rec = Record<string, unknown>;
const list = (doc: Rec | undefined, k: string): Rec[] => (doc && Array.isArray(doc[k]) ? (doc[k] as Rec[]) : []);

/** The node id chant gives an instance: the module calls apart, `module.a[0].aws_x.y` -> `<root>/module.a[0]/aws_x.y`. */
const idOf = (addr: string): string => `${ROOT}/${addr.replace(/(\]|[A-Za-z0-9_-])\.(?=module\.|[a-z0-9_]+\.[A-Za-z0-9_-]+(?:\[[^\]]*\])?$)/g, "$1/")}`;

/** chant's live read of a member for a recorded `live-plan` and, with the listing, `live-ls`. */
function liveIr(planName: string, lsName?: string): Pick<GraphIR, "nodes"> {
  const plan = JSON.parse(raw(planName)) as Rec;
  const ls = lsName ? (JSON.parse(raw(lsName)) as Rec) : undefined;
  const nodes = new Map<string, IRNode & { facts: Rec & { ownershipRows: Rec } }>();
  const at = (addr: string) => {
    let n = nodes.get(addr);
    if (!n) nodes.set(addr, (n = { id: idOf(addr), kind: "Terraform::Resource", lexicon: "terraform", attrs: {}, facts: { ownershipRows: {} } } as never));
    return n!;
  };
  const listed = new Set(list(ls, "items").map((i) => i.address as string));
  for (const b of list(plan, "bound")) {
    const n = at(b.addr as string);
    n.facts.ownership = "bound";
    n.facts.ownershipRows.boundBy = b.source;
    if (b.identity_values) n.facts.ownershipRows.identityValues = b.identity_values;
    if (ls) n.facts.ownershipRows.listed = listed.has(b.addr as string);
    if (b.identity) n.physicalId = b.identity as string;
  }
  for (const o of list(plan, "omissions")) {
    const n = at(o.addr as string);
    n.facts.ownershipRows.omission = { reason: o.reason, detail: o.detail ?? "" };
    if (o.reason === "ABSENT") n.facts.ownership = "pending";
  }
  for (const u of [...list(plan, "unowned"), ...list(plan, "adoptable")]) {
    const n = at(u.addr as string);
    if (u.adopt_tofu_estate) {
      n.facts.ownership = "unowned";
      n.facts.ownershipRows.adopt = {
        owner: u.adopt_tofu_estate,
        ...(u.adopt_tofu_address ? { address: u.adopt_tofu_address } : {}),
        ...(u.hint || u.adopt_command ? { command: u.hint || u.adopt_command } : {}),
        ...(Array.isArray(u.matched) && u.matched.length ? { matched: u.matched } : {}),
      };
    } else {
      n.facts.ownership = "foreign";
      if (u.tofu_estate) n.facts.markers = { owner: u.tofu_estate };
    }
    if (u.identity) n.physicalId = u.identity as string;
  }
  for (const g of list(ls, "gaps")) {
    const n = at(g.address as string);
    n.facts.ownershipRows.gaps = [{ read: "listing", reason: g.rung, detail: g.detail }];
  }
  return { nodes: [...nodes.values()] };
}

const paint = (rosterName: string, planName: string, lsName?: string, estate?: string): GraphIR =>
  paintChoudoufuOwnership(liveCheckToIr(check(rosterName)), liveIr(planName, lsName), ROOT, estate);
const card = (ir: GraphIR, id: string) => ir.nodes.find((n) => n.id === id)!;
const status = (ir: GraphIR, id: string): unknown => card(ir, id).attrs._status;

describe("chant's ids as choudoufu's addresses (behold#1227)", () => {
  it("joins the module calls back with dots, and keeps a key with a slash in it whole", () => {
    expect(instanceAddressOf({ id: "estate/aws_iam_role.x" }, ROOT)).toBe("aws_iam_role.x");
    expect(instanceAddressOf({ id: 'estate/module.edge["east/1"]/aws_eip.pool[1]' }, ROOT)).toBe('module.edge["east/1"].aws_eip.pool[1]');
    expect(instanceAddressOf({ id: "estate/module.a[0]/module.b/aws_x.y~2" }, ROOT)).toBe("module.a[0].module.b.aws_x.y");
    expect(instanceAddressOf({ id: "other/aws_x.y" }, ROOT)).toBeUndefined();
  });
});

describe("the palette, from chant's facts (behold#1227)", () => {
  it("a clean estate: every declared instance good, bound how it was bound, with the live id and the listing's row", () => {
    const ir = paint("choudoufu-live-check-monolith.json", "choudoufu-live-plan-monolith-clean.json", "choudoufu-live-ls-monolith.json", "tlmig-sample-monolith");
    expect(ir.nodes).toHaveLength(21);
    expect(new Set(ir.nodes.map((n) => n.attrs._status))).toEqual(new Set(["good"]));
    const policy = card(ir, "aws_iam_policy.team_a");
    expect(policy.attrs.bound).toBe("by its marker (the estate-wide tag sweep)");
    expect(policy.attrs.marker).toBe(MARKER_ON);
    expect(policy.physicalId).toBe("arn:aws:iam::000000000000:policy/tlmig-sample-team-a-policy");
    expect(policy.ownership).toBe("owned");
    expect(choudoufuCardFields(policy as never, { boxEstate: "tlmig-sample-monolith" })).toEqual([{ label: "ownership", value: "bound" }]);
    const inline = card(ir, "aws_iam_role_policy.team_a_inline");
    expect(inline.attrs.bound).toContain("derived identity");
    expect(inline.attrs.marker).toBe(MARKER_NONE);
    // The listing cannot see it (declaration-carried): a row, not a colour.
    expect(inline.attrs.listing).toContain("no settable tags argument");
    expect(inline.attrs._status).toBe("good");
  });

  it("an unowned neighbour is warn with the adopting tag write; a live object marked for another address is warn with who holds it", () => {
    const doc = check("choudoufu-live-check-monolith.json");
    doc.instances.push({ address: "aws_cloudwatch_log_group.extra", type: "aws_cloudwatch_log_group", rung: "tag-governable" });
    doc.instances.push({ address: "aws_cloudwatch_log_group.team_a_zero", type: "aws_cloudwatch_log_group", rung: "tag-governable" });
    const ir = paintChoudoufuOwnership(liveCheckToIr(doc), liveIr("choudoufu-live-plan-monolith-unowned-and-renamed.json"), ROOT);
    const extra = card(ir, "aws_cloudwatch_log_group.extra");
    expect(extra.attrs._status).toBe("warn");
    expect(extra.attrs.omission).toBe("UNOWNED");
    // #393 item 10: the line to copy comes before the paragraph that explains the omission.
    expect(extra.attrs.adopt).toBe("tofu-estate=tlmig-sample-monolith tofu-address=aws_cloudwatch_log_group.extra");
    expect(Object.keys(extra.attrs).indexOf("adopt")).toBeLessThan(Object.keys(extra.attrs).indexOf("detail"));
    expect(extra.physicalId).toBe("/tlmig-sample/extra");
    expect(extra.ownership).toBe("foreign");
    const zero = card(ir, "aws_cloudwatch_log_group.team_a_zero");
    expect(zero.attrs._status).toBe("warn");
    expect(zero.attrs.ownedBy).toBe("tlmig-sample-monolith");
    expect(zero.attrs.adopt).toBeUndefined();
  });

  it("after a split: the moved role belongs elsewhere on the source side; on the destination side its neighbours do, and what the plan could not discover is neutral", () => {
    const mono = paint("choudoufu-live-check-monolith.json", "choudoufu-live-plan-monolith-after-split.json");
    expect(status(mono, "aws_iam_role.team_a")).toBe("warn");
    expect(card(mono, "aws_iam_role.team_a").attrs.ownedBy).toBe("tlmig-sample-team-a");

    const teamA = paint("choudoufu-live-check-team-a.json", "choudoufu-live-plan-team-a-after-split.json", "choudoufu-live-ls-team-a-after-split.json");
    expect(status(teamA, "aws_iam_role.team_a")).toBe("good");
    expect(status(teamA, "aws_iam_role_policy.team_a_inline")).toBe("good");
    expect(status(teamA, "aws_cloudwatch_log_group.team_a_0")).toBe("warn");
    expect(card(teamA, "aws_cloudwatch_log_group.team_a_0").attrs.ownedBy).toBe("tlmig-sample-monolith");
    expect(status(teamA, "aws_iam_policy.team_a")).toBe("neutral");
    expect(card(teamA, "aws_iam_policy.team_a").attrs.omission).toBe("NEEDS_DISCOVERY");
    expect(status(teamA, "aws_iam_role_policy_attachment.team_a")).toBe("neutral");
  });

  it("each word reads as chant's drift record reads it, and a node with none is not observed with the reason", () => {
    const v = (facts: Rec) => ownershipVerdictOf({ id: "estate/x", facts });
    expect(v({ ownership: "bound", ownershipRows: { boundBy: "marker", listed: true } })).toMatchObject({ status: "in-sync", ownership: "owned", attrs: { marker: MARKER_ON } });
    expect(v({ ownership: "pending", ownershipRows: { omission: { reason: "ABSENT", detail: "not created" } } })).toMatchObject({ status: "pending", attrs: { omission: "ABSENT" } });
    expect(v({ ownership: "unowned", ownershipRows: { adopt: { owner: "e", address: "x", matched: [{ attribute: "name", value: "n" }] } } })).toMatchObject({
      status: "unclaimed",
      attrs: { adopt: "tofu-estate=e tofu-address=x", matchedOn: "name=n" },
    });
    expect(v({ ownership: "foreign", markers: { owner: "other" } })).toMatchObject({ status: "unclaimed", ownership: "foreign", attrs: { ownedBy: "other" } });
    expect(v({ ownershipRows: { omission: { reason: "FAILED", detail: "the read failed" } } })).toMatchObject({ status: "not-observed", unobserved: "the read failed" });
    expect(adoptLine({ command: "aws tag ..." })).toBe("aws tag ...");
    expect(adoptLine(undefined)).toBeUndefined();
  });

  it("an instance chant placed nothing at is neutral with a reason; a data source stays uncoloured; a bound object nothing declares becomes a warn card", () => {
    const doc = check("choudoufu-live-check-monolith.json");
    doc.instances.push({ address: "aws_s3_bucket.ghost", type: "aws_s3_bucket", rung: "tag-governable" });
    doc.references.push({ from: "data.aws_vpc.net", estate: "net", address: "aws_vpc.main", read_by: ["aws_s3_bucket.ghost"] });
    const live = liveIr("choudoufu-live-plan-monolith-clean.json");
    (live.nodes as IRNode[]).push({ id: `${ROOT}/aws_cloudwatch_log_group.stray`, kind: "Terraform::Resource", lexicon: "terraform", attrs: { type: "aws_cloudwatch_log_group" }, physicalId: "/stray", facts: { ownership: "bound" } } as IRNode);
    const ir = paintChoudoufuOwnership(liveCheckToIr(doc), live, ROOT, "tlmig-sample-monolith");
    expect(card(ir, "aws_s3_bucket.ghost").attrs).toMatchObject({ _status: "neutral", _unobserved: "chant's live read placed nothing at this address" });
    expect("_status" in card(ir, "data.aws_vpc.net").attrs).toBe(false);
    const stray = card(ir, "aws_cloudwatch_log_group.stray");
    expect(stray).toMatchObject({ kind: "aws_cloudwatch_log_group", lexicon: "choudoufu", physicalId: "/stray", ownership: "owned", attrs: { _status: "warn", estate: "tlmig-sample-monolith" } });
    expect(stray.attrs.marked).toContain("declared nowhere");
  });
});

describe("the pane's live state (behold#1227)", () => {
  it("one entry per card, keyed by the composed id, with the verdict's rows and the rung last", () => {
    const roster = check("choudoufu-live-check-team-a.json");
    const ir = paintChoudoufuOwnership(liveCheckToIr(roster), liveIr("choudoufu-live-plan-team-a-after-split.json"), ROOT);
    const nodes = choudoufuDiffNodes({ check: roster, ir, drift: new Map() }, "team-a");
    expect(nodes["team-a/aws_iam_role.team_a"]).toMatchObject({ health: "healthy", diff: null, fieldDrift: null });
    expect(nodes["team-a/aws_cloudwatch_log_group.team_a_0"]).toMatchObject({ health: "degraded", observed: { ownership: "foreign" } });
    const attrs = (nodes["team-a/aws_iam_role.team_a"]!.observed as { attributes: Rec }).attributes;
    expect(Object.keys(attrs).at(-1)).toBe("rung");
  });
});

describe("the owned-by edge across members (#370)", () => {
  it("draws the source estate's moved card to the sibling's card of the same address, and back for the neighbours", () => {
    const mono = paint("choudoufu-live-check-monolith.json", "choudoufu-live-plan-monolith-after-split.json");
    const teamA = paint("choudoufu-live-check-team-a.json", "choudoufu-live-plan-team-a-after-split.json", "choudoufu-live-ls-team-a-after-split.json");
    const ir = addChoudoufuReferenceEdges(composeStacks([
      { name: "mono", ir: mono },
      { name: "team-a", ir: teamA },
    ]));
    const owned = ir.edges.filter((e) => e.viaAttr === "owned-by").map((e) => `${e.from} -> ${e.to}`);
    expect(owned).toContain("mono/aws_iam_role.team_a -> team-a/aws_iam_role.team_a");
    expect(owned).toContain("team-a/aws_cloudwatch_log_group.team_a_0 -> mono/aws_cloudwatch_log_group.team_a_0");
    expect(owned).toHaveLength(4);
    expect(ir.edges.filter((e) => e.from === e.to)).toEqual([]);
  });
});

describe("projectChoudoufuLogical — the estate box (#370)", () => {
  it("one box per estate, every card in it, only the tool's own edges", () => {
    const app = liveCheckToIr(check("choudoufu-live-check-consumer.json"));
    const net = liveCheckToIr({ dir: ".", estate: "spike-net", blocked: false, exit_code: 0, schemas: "provider", instances: [{ address: "aws_vpc.main", type: "aws_vpc", rung: "tag-governable" }], references: [], checked: [] });
    const composed = addChoudoufuReferenceEdges(composeStacks([
      { name: "net", ir: net },
      { name: "app", ir: app },
    ]));
    composed.nodes.push({ id: "k8s/deploy", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: {} });
    composed.edges.push({ from: "k8s/deploy", to: "net/aws_vpc.main", kind: "ref" });
    const p = projectChoudoufuLogical(composed);
    expect(p.byContainer).toEqual({ [estateBoxTitle("spike-net")]: ["net/aws_vpc.main"], [estateBoxTitle("spike-app")]: ["app/aws_subnet.app", "app/aws_subnet.app2", "app/data.aws_vpc.network"] });
    expect(p.ir.nodes.map((n) => n.id)).not.toContain("k8s/deploy");
    expect(projectChoudoufuLogical({ nodes: [], edges: [], groups: {} })).toEqual({ ir: { nodes: [], edges: [], groups: {} }, byContainer: {} });
  });
});
