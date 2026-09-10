import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeStacks } from "@intentius/pinhole";
import { addChoudoufuReferenceEdges, liveCheckToIr, parseLiveCheck, type LiveCheckDocument } from "./choudoufu-member.ts";
import {
  BOUND_SOURCES,
  GAP_RUNGS,
  OMISSION_REASONS,
  choudoufuDiffNodes,
  paintChoudoufu,
  parseLiveLs,
  parseLivePlan,
  readChoudoufuLive,
  verdictFor,
  type LiveLsDocument,
  type LivePlanDocument,
} from "./choudoufu-live.ts";
import { estateBoxTitle, projectChoudoufuLogical } from "./logical-choudoufu.ts";

// Fixture provenance (#370). Printed by a choudoufu built from main at
// `9c7d3701e2` (v0.15.0 plus the #966/#967/#968 merges of 2026-09-08) against
// a scratch floci (`behold-spike-floci`, 127.0.0.1:4650, torn down after),
// with the live-mv workbench's `tlmig-sample-monolith` fixture applied. Nothing
// hand-edited. The sequence, so the drift in each document is explained:
//
//  1. apply the monolith (21 resources)
//     - choudoufu-live-ls-monolith.json          `live-ls -json .`: 15 items, 6 gaps (the
//       inline policies and attachments, declaration-carried), schemas provider
//     - choudoufu-live-ls-monolith-no-dir.json   no DIR: `declared: false` throughout,
//       schemas builtin, `gaps_skipped` says why
//     - choudoufu-live-plan-monolith-clean.json  21 bound (3 by marker, 18 derived)
//  2. `aws logs create-log-group /tlmig-sample/extra` (untagged) + declare it;
//     rename block team_a_0 → team_a_zero
//     - choudoufu-live-plan-monolith-unowned-and-renamed.json: extra UNOWNED +
//       adoptable; team_a_zero UNOWNED, the live object marked for the old
//       address in this same estate
//  3. `live-mv -from-estate=tlmig-sample-monolith aws_iam_role.team_a` in a
//     tlmig-sample-team-a copy (the split)
//     - choudoufu-live-ls-team-a-after-split.json  `-consistent`: 1 item, 2 gaps
//     - choudoufu-live-plan-team-a-after-split.json  role + inline bound; the
//       three log groups UNOWNED (owned by the monolith); policy
//       NEEDS_DISCOVERY; attachment PARENT_UNAVAILABLE
//     - choudoufu-live-plan-monolith-after-split.json  aws_iam_role.team_a
//       UNOWNED, owned by tlmig-sample-team-a
//     - choudoufu-live-check-team-a.json  the team-a copy's roster (7
//       instances, after init), the declared half the two above paint
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (name: string): string => readFileSync(join(HERE, "__fixtures__", name), "utf8");
const ok = { code: 0, stderr: "" };
const ls = (name: string): LiveLsDocument => {
  const p = parseLiveLs({ ...ok, stdout: raw(name) }, "/est");
  if (!p.ok) throw new Error(p.refusal.error);
  return p.doc;
};
const plan = (name: string): LivePlanDocument => {
  const p = parseLivePlan({ ...ok, stdout: raw(name) }, "/est");
  if (!p.ok) throw new Error(p.refusal.error);
  return p.doc;
};
const check = (name: string): LiveCheckDocument => {
  const p = parseLiveCheck(JSON.parse(raw(name)));
  if (!p.ok) throw new Error(p.refusal.error);
  return p.doc;
};
const status = (ir: { nodes: { id: string; attrs: Record<string, unknown> }[] }, id: string): unknown => ir.nodes.find((n) => n.id === id)!.attrs._status;

describe("the documents (#370)", () => {
  it("accepts every recorded live-ls and live-plan document", () => {
    for (const f of ["choudoufu-live-ls-monolith.json", "choudoufu-live-ls-monolith-no-dir.json", "choudoufu-live-ls-team-a-after-split.json"]) expect(ls(f).estate).toMatch(/^tlmig-sample/);
    for (const f of ["choudoufu-live-plan-monolith-clean.json", "choudoufu-live-plan-monolith-unowned-and-renamed.json", "choudoufu-live-plan-team-a-after-split.json", "choudoufu-live-plan-monolith-after-split.json"]) {
      expect(plan(f).choudoufu_version).toMatch(/^v0\.15\.0-\d+-g/);
    }
  });

  it("pins the three vocabularies, and every value the fixtures carry is in them", () => {
    expect(BOUND_SOURCES).toEqual(["marker", "record", "derived", "cache"]);
    expect(GAP_RUNGS).toEqual(["record", "declaration-carried"]);
    expect(OMISSION_REASONS).toHaveLength(10);
    const sources = new Set<string>();
    const reasons = new Set<string>();
    const rungs = new Set<string>();
    for (const f of ["choudoufu-live-plan-monolith-clean.json", "choudoufu-live-plan-monolith-unowned-and-renamed.json", "choudoufu-live-plan-team-a-after-split.json", "choudoufu-live-plan-monolith-after-split.json"]) {
      for (const b of plan(f).bound ?? []) sources.add(b.source);
      for (const o of plan(f).omissions ?? []) reasons.add(o.reason);
    }
    for (const f of ["choudoufu-live-ls-monolith.json", "choudoufu-live-ls-team-a-after-split.json"]) for (const g of ls(f).gaps ?? []) rungs.add(g.rung);
    expect([...sources].sort()).toEqual(["derived", "marker"]);
    expect([...reasons].sort()).toEqual(["NEEDS_DISCOVERY", "PARENT_UNAVAILABLE", "UNOWNED"]);
    expect([...rungs]).toEqual(["declaration-carried"]);
    for (const s of sources) expect(BOUND_SOURCES).toContain(s);
    for (const r of reasons) expect(OMISSION_REASONS).toContain(r);
    for (const r of rungs) expect(GAP_RUNGS).toContain(r);
  });

  it("live-ls without DIR: nothing declared, and gaps_skipped says why (choudoufu#966)", () => {
    const d = ls("choudoufu-live-ls-monolith-no-dir.json");
    expect(d.items.every((i) => i.declared === false)).toBe(true);
    expect(d.gaps).toEqual([]);
    expect(d.gaps_skipped).toContain("no configuration directory was given");
  });

  it("refuses a live-ls document with no schemas, an empty stdout with choudoufu's error line, and a missing binary", () => {
    const old = JSON.parse(raw("choudoufu-live-ls-monolith.json")) as Record<string, unknown>;
    delete old.schemas;
    expect(parseLiveLs({ ...ok, stdout: JSON.stringify(old) }, "/est")).toMatchObject({ ok: false, refusal: { error: expect.stringContaining("older than 0.16.0") } });
    expect(parseLiveLs({ code: 1, stdout: "", stderr: "╷\n│ Error: Provider unavailable for marker discovery\n│\n╵\n" }, "/est")).toMatchObject({
      ok: false,
      refusal: { error: "choudoufu live-ls could not list /est: Error: Provider unavailable for marker discovery" },
    });
    expect(parseLivePlan({ code: 127, stdout: "", stderr: "ENOENT" }, "/est")).toMatchObject({ ok: false, refusal: { error: "choudoufu is not on PATH." } });
    expect(parseLivePlan({ ...ok, stdout: "{}" }, "/est").ok).toBe(false);
  });

  it("every bound row carries the identity it was matched on (choudoufu#967), marker rows included", () => {
    const d = plan("choudoufu-live-plan-monolith-unowned-and-renamed.json");
    const marker = (d.bound ?? []).filter((b) => b.source === "marker");
    expect(marker.length).toBeGreaterThan(0);
    for (const b of marker) expect(b.identity).toMatch(/^arn:aws:iam::/);
  });
});

describe("verdictFor and paintChoudoufu — the palette (#370)", () => {
  it("a clean estate: every declared instance good, bound how it was bound, with the live id", () => {
    const ir = paintChoudoufu(liveCheckToIr(check("choudoufu-live-check-monolith.json")), ls("choudoufu-live-ls-monolith.json"), plan("choudoufu-live-plan-monolith-clean.json"), "tlmig-sample-monolith");
    expect(ir.nodes).toHaveLength(21);
    expect(new Set(ir.nodes.map((n) => n.attrs._status))).toEqual(new Set(["good"]));
    const policy = ir.nodes.find((n) => n.id === "aws_iam_policy.team_a")!;
    expect(policy.attrs.bound).toBe("by its marker (the estate-wide tag sweep)");
    expect(policy.physicalId).toBe("arn:aws:iam::000000000000:policy/tlmig-sample-team-a-policy");
    expect(policy.ownership).toBe("owned");
    const inline = ir.nodes.find((n) => n.id === "aws_iam_role_policy.team_a_inline")!;
    expect(inline.attrs.bound).toContain("derived identity");
    // The listing cannot see it (declaration-carried) — a row, not a colour.
    expect(inline.attrs.listing).toContain("no settable tags argument");
    expect(inline.attrs._status).toBe("good");
  });

  it("an unowned neighbour is warn with the adopting tag write; a live object marked for another address in the same estate is warn with ownedBy", () => {
    const doc = check("choudoufu-live-check-monolith.json");
    doc.instances.push({ address: "aws_cloudwatch_log_group.extra", type: "aws_cloudwatch_log_group", rung: "tag-governable" });
    doc.instances.push({ address: "aws_cloudwatch_log_group.team_a_zero", type: "aws_cloudwatch_log_group", rung: "tag-governable" });
    const ir = paintChoudoufu(liveCheckToIr(doc), ls("choudoufu-live-ls-monolith.json"), plan("choudoufu-live-plan-monolith-unowned-and-renamed.json"));
    const extra = ir.nodes.find((n) => n.id === "aws_cloudwatch_log_group.extra")!;
    expect(extra.attrs._status).toBe("warn");
    expect(extra.attrs.omission).toBe("UNOWNED");
    expect(extra.attrs.adopt).toEqual({ "tofu-estate": "tlmig-sample-monolith", "tofu-address": "aws_cloudwatch_log_group.extra" });
    expect(extra.physicalId).toBe("/tlmig-sample/extra");
    expect(extra.ownership).toBe("foreign");
    const zero = ir.nodes.find((n) => n.id === "aws_cloudwatch_log_group.team_a_zero")!;
    expect(zero.attrs._status).toBe("warn");
    expect(zero.attrs.ownedBy).toBe("tlmig-sample-monolith");
    expect(zero.attrs.adopt).toBeUndefined();
  });

  it("after a split: the moved role belongs elsewhere on the source side; on the destination side its neighbours do, and what the tool could not discover is neutral", () => {
    const mono = paintChoudoufu(liveCheckToIr(check("choudoufu-live-check-monolith.json")), undefined, plan("choudoufu-live-plan-monolith-after-split.json"));
    const role = mono.nodes.find((n) => n.id === "aws_iam_role.team_a")!;
    expect(role.attrs._status).toBe("warn");
    expect(role.attrs.ownedBy).toBe("tlmig-sample-team-a");

    const teamA = paintChoudoufu(liveCheckToIr(check("choudoufu-live-check-team-a.json")), ls("choudoufu-live-ls-team-a-after-split.json"), plan("choudoufu-live-plan-team-a-after-split.json"));
    expect(status(teamA, "aws_iam_role.team_a")).toBe("good");
    expect(status(teamA, "aws_iam_role_policy.team_a_inline")).toBe("good");
    expect(status(teamA, "aws_cloudwatch_log_group.team_a_0")).toBe("warn");
    expect(teamA.nodes.find((n) => n.id === "aws_cloudwatch_log_group.team_a_0")!.attrs.ownedBy).toBe("tlmig-sample-monolith");
    expect(status(teamA, "aws_iam_policy.team_a")).toBe("neutral");
    expect(teamA.nodes.find((n) => n.id === "aws_iam_policy.team_a")!.attrs.omission).toBe("NEEDS_DISCOVERY");
    expect(teamA.nodes.find((n) => n.id === "aws_iam_policy.team_a")!.attrs._unobserved).toBeUndefined(); // the rung said why
    expect(status(teamA, "aws_iam_role_policy_attachment.team_a")).toBe("neutral");
  });

  it("the ten reasons: UNOWNED warn, ABSENT accent, three neutral by rung, five neutral and unobserved", () => {
    const at = (reason: string) => verdictFor("x", undefined, { estate: "e", choudoufu_version: "", upstream_version: "", omissions: [{ addr: "x", reason, detail: `d ${reason}` }] })!;
    expect(at("ABSENT")._status).toBe("accent");
    expect(at("UNOWNED")._status).toBe("warn"); // even with no unowned[] row to pair
    for (const r of ["NEEDS_DISCOVERY", "PARENT_UNAVAILABLE", "LISTED_NOT_IMPORTABLE"]) expect(at(r)).toMatchObject({ _status: "neutral" });
    for (const r of ["NEEDS_DISCOVERY", "PARENT_UNAVAILABLE", "LISTED_NOT_IMPORTABLE"]) expect(at(r)._unobserved).toBeUndefined();
    for (const r of ["FAILED", "CYCLE", "SUPERSEDED", "UNREADABLE", "INCOMPLETE_BLOCK"]) expect(at(r)).toEqual({ _status: "neutral", _unobserved: `d ${r}`, attrs: { omission: r, detail: `d ${r}` } });
    expect(at("SOMETHING_NEW")._status).toBe("neutral"); // an unknown word never paints drift
  });

  it("a resource under the estate's tag that nothing declares becomes a warn card; a declared one neither document mentions is neutral with a reason; a data source stays uncoloured", () => {
    const listing = ls("choudoufu-live-ls-monolith.json");
    listing.items.push({ id: "arn:aws:logs:us-east-1:000000000000:log-group:/stray", type: "aws_cloudwatch_log_group", address: "aws_cloudwatch_log_group.stray", declared: false, source: "tagging", tags: { "tofu-estate": "tlmig-sample-monolith", "tofu-address": "aws_cloudwatch_log_group.stray" } });
    const doc = check("choudoufu-live-check-monolith.json");
    doc.instances.push({ address: "aws_s3_bucket.ghost", type: "aws_s3_bucket", rung: "tag-governable" });
    doc.references.push({ from: "data.aws_vpc.net", estate: "net", address: "aws_vpc.main", read_by: ["aws_s3_bucket.ghost"] });
    const ir = paintChoudoufu(liveCheckToIr(doc), listing, plan("choudoufu-live-plan-monolith-clean.json"), "tlmig-sample-monolith");
    const stray = ir.nodes.find((n) => n.id === "aws_cloudwatch_log_group.stray")!;
    expect(stray).toMatchObject({ kind: "aws_cloudwatch_log_group", lexicon: "choudoufu", physicalId: expect.stringContaining("/stray"), ownership: "owned", attrs: { _status: "warn", estate: "tlmig-sample-monolith" } });
    expect(stray.attrs.marked).toContain("declared nowhere");
    const ghost = ir.nodes.find((n) => n.id === "aws_s3_bucket.ghost")!;
    expect(ghost.attrs).toMatchObject({ _status: "neutral", _unobserved: "not mentioned by live-plan or live-ls" });
    expect("_status" in ir.nodes.find((n) => n.id === "data.aws_vpc.net")!.attrs).toBe(false);
  });

  it("with no plan document at all, every card is neutral and says so", () => {
    const ir = paintChoudoufu(liveCheckToIr(check("choudoufu-live-check-monolith.json")), undefined, undefined);
    expect(new Set(ir.nodes.map((n) => n.attrs._unobserved))).toEqual(new Set(["no live-plan document for this estate"]));
  });
});

describe("the owned-by edge across members (#370)", () => {
  it("draws the source estate's moved card to the sibling's card of the same address, dashed, and back for the neighbours", () => {
    const mono = paintChoudoufu(liveCheckToIr(check("choudoufu-live-check-monolith.json")), undefined, plan("choudoufu-live-plan-monolith-after-split.json"));
    const teamA = paintChoudoufu(liveCheckToIr(check("choudoufu-live-check-team-a.json")), ls("choudoufu-live-ls-team-a-after-split.json"), plan("choudoufu-live-plan-team-a-after-split.json"));
    const ir = addChoudoufuReferenceEdges(composeStacks([{ name: "mono", ir: mono }, { name: "team-a", ir: teamA }]));
    const owned = ir.edges.filter((e) => e.viaAttr === "owned-by").map((e) => `${e.from} -> ${e.to}`);
    expect(owned).toContain("mono/aws_iam_role.team_a -> team-a/aws_iam_role.team_a");
    expect(owned).toContain("team-a/aws_cloudwatch_log_group.team_a_0 -> mono/aws_cloudwatch_log_group.team_a_0");
    expect(owned).toHaveLength(4);
    // A live object marked for another address in its OWN estate never gets a self edge.
    const self = ir.edges.filter((e) => e.from === e.to);
    expect(self).toEqual([]);
  });
});

describe("readChoudoufuLive — the three spawns (#370)", () => {
  const docs = {
    check: raw("choudoufu-live-check-monolith.json"),
    ls: raw("choudoufu-live-ls-monolith.json"),
    plan: raw("choudoufu-live-plan-monolith-clean.json"),
  };
  const runner = (over: Partial<Record<"live-check" | "live-ls" | "live-plan", { code: number; stdout: string; stderr: string }>> = {}, calls: string[][] = []) =>
    async (args: string[]) => {
      calls.push(args);
      const verb = args[0] as "live-check" | "live-ls" | "live-plan";
      return over[verb] ?? { code: 0, stderr: "", stdout: verb === "live-check" ? docs.check : verb === "live-ls" ? docs.ls : docs.plan };
    };

  it("runs live-check first, then live-ls with the estate it named and live-plan with no -estate, and -consistent only when asked", async () => {
    const calls: string[][] = [];
    const r = await readChoudoufuLive("/est/mono", {}, runner({}, calls));
    // live-ls reads no configuration and REQUIRES the name; live-plan reads
    // the configuration and REFUSES the flag beside a live block.
    expect(calls.map((a) => a.join(" "))).toEqual(["live-check -json .", "live-ls -estate=tlmig-sample-monolith -json .", "live-plan -json"]);
    expect(r.plan.bound).toHaveLength(21);
    const consistent: string[][] = [];
    await readChoudoufuLive("/est/mono", { consistent: true }, runner({}, consistent));
    expect(consistent.find((a) => a[0] === "live-ls")).toEqual(["live-ls", "-estate=tlmig-sample-monolith", "-json", "-consistent", "."]);
  });

  it("refuses a member that names no estate: there is no estate tag to list under", async () => {
    const noEstate = raw("choudoufu-live-check-estate-references.json"); // choudoufu's own fixture, no estate named
    await expect(readChoudoufuLive("/est/refs", {}, runner({ "live-check": { code: 0, stdout: noEstate, stderr: "" } }))).rejects.toThrow("names no estate");
  });

  it("throws with the plan's own error when live-plan carries an error diagnostic, and with the refusal when a read is refused", async () => {
    const withError = JSON.parse(docs.plan) as LivePlanDocument;
    withError.diagnostics = [{ severity: "error", summary: "Provider unavailable for marker discovery", detail: "cannot read the schema\nmore" }];
    await expect(readChoudoufuLive("/est/mono", {}, runner({ "live-plan": { code: 1, stdout: JSON.stringify(withError), stderr: "" } }))).rejects.toThrow(
      "choudoufu live-check /est/mono exited 1: live-plan: Provider unavailable for marker discovery — cannot read the schema",
    );
    await expect(readChoudoufuLive("/est/mono", {}, runner({ "live-ls": { code: 1, stdout: "", stderr: "Error: no credentials" } }))).rejects.toThrow("could not list /est/mono: Error: no credentials");
  });
});

describe("choudoufuDiffNodes — the pane's live state (#370)", () => {
  it("keys by the composed id, and speaks the pane's health vocabulary", () => {
    const doc = check("choudoufu-live-check-monolith.json");
    doc.instances.push({ address: "aws_cloudwatch_log_group.extra", type: "aws_cloudwatch_log_group", rung: "tag-governable" });
    const listing = ls("choudoufu-live-ls-monolith.json");
    listing.items.push({ id: "arn:stray", type: "aws_sqs_queue", address: "aws_sqs_queue.stray", declared: false, source: "tagging", tags: {} });
    const nodes = choudoufuDiffNodes(doc, listing, plan("choudoufu-live-plan-monolith-unowned-and-renamed.json"), "mono");
    expect(nodes["mono/aws_iam_policy.team_a"]).toMatchObject({
      health: "healthy",
      healthDetail: "bound by its marker (the estate-wide tag sweep)",
      observed: { type: "aws_iam_policy", physicalId: expect.stringContaining("policy/tlmig-sample-team-a-policy"), ownership: "owned", attributes: { rung: "tag-governable" } },
      diff: null,
      fieldDrift: null,
    });
    expect(nodes["mono/aws_cloudwatch_log_group.extra"]).toMatchObject({ health: "degraded", healthDetail: expect.stringMatching(/^UNOWNED: /), observed: { ownership: "foreign", physicalId: "/tlmig-sample/extra" } });
    expect(nodes["mono/aws_sqs_queue.stray"]).toMatchObject({ health: "degraded", healthDetail: expect.stringContaining("declared nowhere"), observed: { physicalId: "arn:stray" } });
    // Unprefixed on a single-member serve.
    expect(Object.keys(choudoufuDiffNodes(doc, listing, plan("choudoufu-live-plan-monolith-clean.json")))).toContain("aws_iam_role.team_a");
  });
});

describe("projectChoudoufuLogical — the estate box (#370)", () => {
  it("one box per estate, every card in it, only the tool's own edges", () => {
    const app = liveCheckToIr(check("choudoufu-live-check-consumer.json"));
    const net = liveCheckToIr({ dir: ".", estate: "spike-net", blocked: false, exit_code: 0, schemas: "provider", instances: [{ address: "aws_vpc.main", type: "aws_vpc", rung: "tag-governable" }], references: [], checked: [] });
    const composed = addChoudoufuReferenceEdges(composeStacks([{ name: "net", ir: net }, { name: "app", ir: app }]));
    composed.nodes.push({ id: "k8s/deploy", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: {} });
    composed.edges.push({ from: "k8s/deploy", to: "net/aws_vpc.main", kind: "ref" });
    const p = projectChoudoufuLogical(composed);
    expect(p.byContainer).toEqual({ [estateBoxTitle("spike-net")]: ["net/aws_vpc.main"], [estateBoxTitle("spike-app")]: ["app/aws_subnet.app", "app/aws_subnet.app2", "app/data.aws_vpc.network"] });
    expect(p.ir.nodes.map((n) => n.id)).not.toContain("k8s/deploy");
    expect(p.ir.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["app/aws_subnet.app>app/data.aws_vpc.network", "app/aws_subnet.app2>app/data.aws_vpc.network", "app/data.aws_vpc.network>net/aws_vpc.main"]);
    expect(projectChoudoufuLogical({ nodes: [], edges: [], groups: {} })).toEqual({ ir: { nodes: [], edges: [], groups: {} }, byContainer: {} });
  });
});
