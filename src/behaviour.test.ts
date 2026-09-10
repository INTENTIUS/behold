import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { attachBehaviour, validateBehaviourBlock, validateBehaviourMeta, type BehaviourBlock, type BehaviourMeta } from "./behaviour.ts";

/**
 * The behaviour overlay (#398, M1 of #397) over a two-member choudoufu estate
 * on disk, with the choudoufu spawn answered from recorded documents — no
 * binary, no cloud, the pattern src/choudoufu-route.test.ts established.
 *
 * ## Where the numbers come from
 *
 * Nowhere. Every figure in this file is a RECORDED DOCUMENT, and its
 * provenance says so out loud: `engine: "behold-fixture"`, `version: "0"`,
 * `tolerance: "fixture"`. No behavioural engine exists yet (#397 keeps the
 * engine abstract on purpose, and chant #2356 is the half that will write
 * these for real), so the documents below were WRITTEN, not observed —
 * generated once against the bundled `example-choudoufu-estate`'s own declared
 * addresses so the join is real even though the pricing is not. That labelling
 * is the only way a figure may appear in this build: behold computes nothing
 * but the sums, and the sums are named `sum`.
 *
 *  - `behaviour-report-choudoufu-monolith.json` — the monolith's 21 declared
 *    addresses, 20 of them priced. `aws_iam_role_policy_attachment.team_c` is
 *    deliberately absent, so the card renders with no behaviour key at all and
 *    the `unpriced` counter has something to count. One `rightSize`
 *    (`aws_cloudwatch_log_group.team_b_1`), one `resilience.verdict:
 *    "degrades"` (`aws_iam_role.team_b`), one single-axis headroom
 *    (`aws_iam_policy.team_a`, cpu only) — the three optional shapes the
 *    contract allows, each present exactly once. A copy of this same file is
 *    committed at `example-choudoufu-estate/monolith/behaviour.live.json` so
 *    the demo's overlay carries the block; the three team estates carry their
 *    own seven-address reports beside it.
 *  - `behaviour-report-refused.json` — the same engine refusing, with two
 *    VALID entity blocks still in the document, so the refusal has something
 *    to strip rather than merely nothing to add.
 *  - `behaviour-report-malformed.json` — one sound block and five that each
 *    break a different required field (no `provenance.tolerance`, a verdict
 *    outside the three words, an empty `headroom`, an `errorRate` of 4, a cost
 *    with no currency), so a drop is per entity and its reason is specific.
 *
 * The live half — the roster, the listing and the plan the cards are drawn and
 * coloured from — is the choudoufu-live fixture set recorded from a real
 * `floci` run; src/choudoufu-live.test.ts's header records that provenance.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (name: string): string => readFileSync(join(HERE, "__fixtures__", name), "utf8");

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The estate on disk: the monolith's 21 addresses and team-a's seven. */
function estate(reports: Record<string, string> = {}): { root: string; mono: string; teamA: string } {
  const root = mkdtempSync(join(tmpdir(), "behold-behaviour-"));
  made.push(root);
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  write("mono/main.tf", 'terraform {\n  live {\n    estate = "tlmig-sample-monolith"\n  }\n}\n');
  write("team-a/main.tf", 'terraform {\n  live {\n    estate = "tlmig-sample-team-a"\n  }\n}\n');
  for (const [rel, content] of Object.entries(reports)) write(rel, content);
  return { root, mono: join(root, "mono"), teamA: join(root, "team-a") };
}

/** The spawn seam — live-check/live-ls/live-plan per member, from the recorded
 * documents. Identical to choudoufu-route.test.ts's, minus live-mv: nothing
 * here moves anything. */
const fakeChoudoufu = async (args: string[], cwd: string) => {
  const verb = args[0];
  const inMono = cwd.endsWith("mono");
  if (verb === "live-check") return { code: 0, stderr: "", stdout: inMono ? raw("choudoufu-live-check-monolith.json") : raw("choudoufu-live-check-team-a.json") };
  if (verb === "live-ls") return { code: 0, stderr: "", stdout: inMono ? raw("choudoufu-live-ls-monolith.json") : raw("choudoufu-live-ls-team-a-after-split.json") };
  if (verb === "live-plan") return { code: 0, stderr: "", stdout: inMono ? raw("choudoufu-live-plan-monolith-clean.json") : raw("choudoufu-live-plan-team-a-after-split.json") };
  return { code: 2, stderr: `unexpected ${verb}`, stdout: "" };
};

function served(reports: Record<string, string> = {}) {
  const { mono, teamA } = estate(reports);
  const broadcaster = new Broadcaster();
  const app = createApp(
    { projectDir: mono, projectDirs: [mono, teamA], port: 0, choudoufu: { run: fakeChoudoufu } },
    broadcaster,
    new FrameBuffer(),
    new OpRunner({ projectDir: mono, broadcaster, onDone: () => {} }),
  );
  return { app, mono, teamA };
}

interface OverlayNode {
  id: string;
  attrs?: Record<string, unknown> & { _status?: string; _behaviour?: BehaviourBlock };
}
interface OverlayBody {
  ir: { nodes: OverlayNode[] };
  svg: string;
  meta: { behaviour: BehaviourMeta } & Record<string, unknown>;
}

const overlay = async (app: { request: (p: string) => Promise<Response> | Response }): Promise<OverlayBody> =>
  (await (await app.request("/api/overlay?env=live")).json()) as OverlayBody;

/** Every entity that carries a block, id → cost per hour. */
const priced = (body: OverlayBody): Record<string, number> =>
  Object.fromEntries(body.ir.nodes.filter((n) => n.attrs?._behaviour).map((n) => [n.id, n.attrs!._behaviour!.cost.perHour]));

/** The drift overlay, untouched by any of this. */
const drift = (body: OverlayBody): Record<string, string | undefined> =>
  Object.fromEntries(body.ir.nodes.map((n) => [n.id, n.attrs?._status]));

const MONOLITH = "mono/behaviour.live.json";
const TEAM_A = "team-a/behaviour.live.json";

describe("the behaviour block on /api/overlay (#398)", () => {
  // 1. The golden: the payload the fixture estate produces, pinned.
  it("joins the report document onto the composed ids, and sums per box and per estate", async () => {
    const { app } = served({ [MONOLITH]: raw("behaviour-report-choudoufu-monolith.json") });
    const body = await overlay(app);

    // The join: the file's keys are the member's OWN addresses; behold
    // prefixes them to reach the composed id.
    const blocks = priced(body);
    expect(Object.keys(blocks).sort()).toEqual([
      "mono/aws_cloudwatch_log_group.team_a_0",
      "mono/aws_cloudwatch_log_group.team_a_1",
      "mono/aws_cloudwatch_log_group.team_a_2",
      "mono/aws_cloudwatch_log_group.team_b_0",
      "mono/aws_cloudwatch_log_group.team_b_1",
      "mono/aws_cloudwatch_log_group.team_b_2",
      "mono/aws_cloudwatch_log_group.team_c_0",
      "mono/aws_cloudwatch_log_group.team_c_1",
      "mono/aws_cloudwatch_log_group.team_c_2",
      "mono/aws_iam_policy.team_a",
      "mono/aws_iam_policy.team_b",
      "mono/aws_iam_policy.team_c",
      "mono/aws_iam_role.team_a",
      "mono/aws_iam_role.team_b",
      "mono/aws_iam_role.team_c",
      "mono/aws_iam_role_policy.team_a_inline",
      "mono/aws_iam_role_policy.team_b_inline",
      "mono/aws_iam_role_policy.team_c_inline",
      "mono/aws_iam_role_policy_attachment.team_a",
      "mono/aws_iam_role_policy_attachment.team_b",
    ]);

    // The one address the document deliberately did not price carries NO
    // behaviour key — not a zeroed block. #398's whole acceptance criterion.
    const unpriced = body.ir.nodes.find((n) => n.id === "mono/aws_iam_role_policy_attachment.team_c");
    expect(unpriced).toBeDefined();
    expect(unpriced!.attrs).not.toHaveProperty("_behaviour");

    // One block, in full — the contract's field names, byte for byte.
    expect(body.ir.nodes.find((n) => n.id === "mono/aws_cloudwatch_log_group.team_b_1")!.attrs!._behaviour).toEqual({
      at: { traffic: "100 rps, p50" },
      cost: { perHour: 0.0312, currency: "USD" },
      headroom: { cpu: 0.6, latency: 0.67 },
      errorRate: 0.0004,
      resilience: { failure: "one zone lost", verdict: "survives" },
      rightSize: {
        suggestion: "retention 1 day -> 7 days",
        reason: "the group is read for a week after every deploy and re-ingested when it is not",
      },
      provenance: { engine: "behold-fixture", version: "0", tolerance: "fixture", basis: "modeled" },
    });

    // The optional shapes, each exactly once.
    expect(body.ir.nodes.find((n) => n.id === "mono/aws_iam_role.team_b")!.attrs!._behaviour!.resilience.verdict).toBe("degrades");
    // A missing axis is ABSENT, never 0.
    expect(body.ir.nodes.find((n) => n.id === "mono/aws_iam_policy.team_a")!.attrs!._behaviour!.headroom).toEqual({ cpu: 0.74 });

    // The engine stated no total, so behold sums and says it is a sum.
    // 20 priced of the monolith's 21; team-a supplied nothing at all.
    expect(body.meta.behaviour).toEqual({
      engine: "behold-fixture",
      version: "0",
      at: { traffic: "100 rps, p50" },
      sum: { perHour: 0.2834, currency: "USD", priced: 20, unpriced: 8 },
      boxes: { mono: { perHour: 0.2834, currency: "USD", priced: 20, unpriced: 1 } },
      diagnostics: ["no behaviour source for team-a (no attrs._behaviour, no behaviour.live.json)"],
    });
  });

  // 2. Nothing invented in its place.
  it("renders byte-identically to today with the file removed — only meta.behaviour is added", async () => {
    const withFile = await overlay(served({ [MONOLITH]: raw("behaviour-report-choudoufu-monolith.json") }).app);
    const without = await overlay(served().app);

    // The picture is the same picture.
    expect(without.svg).toBe(withFile.svg);
    expect(drift(without)).toEqual(drift(withFile));
    expect(without.ir.nodes.map((n) => n.id)).toEqual(withFile.ir.nodes.map((n) => n.id));

    // Not one node carries a behaviour key, zeroed or otherwise, and the IRs
    // are identical once the one added attr is taken back off.
    expect(priced(without)).toEqual({});
    const strip = (b: OverlayBody) =>
      JSON.stringify(b.ir.nodes.map((n) => ({ ...n, attrs: Object.fromEntries(Object.entries(n.attrs ?? {}).filter(([k]) => k !== "_behaviour")) })));
    expect(strip(without)).toBe(strip(withFile));

    // What it gained instead: one line naming both places it looked.
    expect(without.meta.behaviour).toEqual({
      absent:
        "no behaviour block: no node carries attrs._behaviour (what `chant graph --live --overlay` would paint from the lexicon's engine), and no report document at mono/behaviour.live.json, team-a/behaviour.live.json",
    });
    // An absence is not a refusal: nothing was configured, so nothing refused.
    expect(without.meta.behaviour.refusal).toBeUndefined();

    // And the rest of the meta is what it always was. (`projectDir` is each
    // server's own temp copy, so it is the one key that legitimately differs.)
    const rest = (b: OverlayBody) => JSON.stringify({ ...b.meta, behaviour: undefined, projectDir: undefined });
    expect(rest(without)).toBe(rest(withFile));
  });

  // 3. The refusal.
  it("a refusal strips every block, prints the lexicon's words verbatim, and leaves drift alone", async () => {
    const coloured = await overlay(served({ [MONOLITH]: raw("behaviour-report-choudoufu-monolith.json") }).app);
    // Both documents present: the monolith prices its estate, team-a refuses.
    // The estate's answer is ONE answer, so the monolith's blocks go too.
    const { app } = served({
      [MONOLITH]: raw("behaviour-report-choudoufu-monolith.json"),
      [TEAM_A]: raw("behaviour-report-refused.json"),
    });
    const body = await overlay(app);

    expect(priced(body)).toEqual({});
    expect(body.meta.behaviour).toEqual({
      refusal: {
        reason: "no behavioural engine is configured for this estate: BEHAVIOUR_ENGINE_URL is unset and the lexicon declares no engine block",
        remedy: "set BEHAVIOUR_ENGINE_URL and BEHAVIOUR_ENGINE_TOKEN in the environment the lexicon runs in, then re-read the overlay",
      },
    });
    // No engine, no sum, no total — a refusal is present INSTEAD of them.
    expect(body.meta.behaviour.sum).toBeUndefined();
    expect(body.meta.behaviour.engine).toBeUndefined();
    // The drift overlay keeps rendering, unchanged.
    expect(drift(body)).toEqual(drift(coloured));
    expect(body.svg).toBe(coloured.svg);
  });

  // 4. The malformed drop.
  it("drops a malformed block per entity with a reason, and renders the sound one", async () => {
    const { app } = served({ [TEAM_A]: raw("behaviour-report-malformed.json") });
    const body = await overlay(app);

    // One block in the document survived validation; five did not.
    expect(priced(body)).toEqual({ "team-a/aws_iam_role.team_a": 0.0004 });
    for (const id of [
      "team-a/aws_iam_role_policy.team_a_inline",
      "team-a/aws_iam_policy.team_a",
      "team-a/aws_iam_role_policy_attachment.team_a",
      "team-a/aws_cloudwatch_log_group.team_a_0",
      "team-a/aws_cloudwatch_log_group.team_a_1",
    ]) {
      expect(body.ir.nodes.find((n) => n.id === id)!.attrs).not.toHaveProperty("_behaviour");
    }
    // Never partially rendered: each drop names the entity and the field.
    expect(body.meta.behaviour.diagnostics).toEqual([
      "dropped the behaviour block on team-a/aws_iam_role_policy.team_a_inline: provenance.tolerance missing — a figure without a stated tolerance is not a prediction",
      'dropped the behaviour block on team-a/aws_iam_policy.team_a: resilience.verdict "probably fine" is not survives/degrades/fails',
      "dropped the behaviour block on team-a/aws_iam_role_policy_attachment.team_a: headroom carries neither cpu nor latency",
      "dropped the behaviour block on team-a/aws_cloudwatch_log_group.team_a_0: errorRate is not a fraction 0..1",
      "dropped the behaviour block on team-a/aws_cloudwatch_log_group.team_a_1: cost.currency missing",
      "no behaviour source for mono (no attrs._behaviour, no behaviour.live.json)",
    ]);
    expect(body.meta.behaviour.sum).toEqual({ perHour: 0.0004, currency: "USD", priced: 1, unpriced: 27 });
  });

  // 6. The advertisement (#398 item 6).
  it("is advertised on /api", async () => {
    const { app } = served();
    const api = (await (await app.request("/api")).json()) as { routes: Array<{ path: string; desc: string }> };
    const route = api.routes.find((r) => r.path === "/api/overlay")!;
    expect(route.desc).toContain("attrs._behaviour");
    expect(route.desc).toContain("meta.behaviour");
  });
});

// ---------------------------------------------------------------------------
// 5. The arithmetic, on the pass itself — the one thing behold computes.
// ---------------------------------------------------------------------------

const block = (perHour: number, currency = "USD"): BehaviourBlock => ({
  at: { traffic: "100 rps, p50" },
  cost: { perHour, currency },
  headroom: { cpu: 0.5 },
  errorRate: 0.001,
  resilience: { failure: "one zone lost", verdict: "survives" },
  provenance: { engine: "behold-fixture", version: "0", tolerance: "fixture", basis: "modeled" },
});

const irOf = (nodes: Array<{ id: string; block?: BehaviourBlock }>) => ({
  nodes: nodes.map((n) => ({ id: n.id, attrs: { _status: "good", ...(n.block ? { _behaviour: n.block } : {}) } })),
  groups: {
    byStack: {
      mono: nodes.filter((n) => n.id.startsWith("mono/")).map((n) => n.id),
      "team-a": nodes.filter((n) => n.id.startsWith("team-a/")).map((n) => n.id),
    },
  },
});

const members = [
  { name: "mono", dir: "/nowhere/mono" },
  { name: "team-a", dir: "/nowhere/team-a" },
];
/** No file exists anywhere: these cases are all source 1, the node attr. */
const noFiles = () => undefined;

describe("the sums (#398 item 4)", () => {
  it("adds per box and per estate, counts priced and unpriced, and never calls the total a total", () => {
    const ir = irOf([
      { id: "mono/a", block: block(0.0416) },
      { id: "mono/b", block: block(0.0312) },
      { id: "mono/c" },
      { id: "team-a/a", block: block(0.0208) },
    ]);
    const meta = attachBehaviour(ir, members, "live", noFiles);
    expect(meta.sum).toEqual({ perHour: 0.0936, currency: "USD", priced: 3, unpriced: 1 });
    expect(meta.boxes).toEqual({
      mono: { perHour: 0.0728, currency: "USD", priced: 2, unpriced: 1 },
      "team-a": { perHour: 0.0208, currency: "USD", priced: 1, unpriced: 0 },
    });
    // `total` is the ENGINE's word and this engine stated none.
    expect(meta.total).toBeUndefined();
  });

  it("shows the engine's own total instead of a sum when the engine states one", () => {
    const ir = irOf([
      { id: "mono/a", block: block(0.0416) },
      { id: "mono/b", block: block(0.0312) },
    ]);
    const engineMeta = { engine: "behold-fixture", version: "0", at: { traffic: "100 rps, p50" }, total: { perHour: 12.31, currency: "USD" } };
    const meta = attachBehaviour(ir, [{ name: "mono", dir: "/nowhere/mono", meta: engineMeta }], "live", noFiles);
    expect(meta.total).toEqual({ perHour: 12.31, currency: "USD" });
    expect(meta.sum).toBeUndefined();
    expect(meta.boxes).toBeUndefined();
  });

  it("refuses to sum mixed currencies, and says why rather than converting", () => {
    const ir = irOf([
      { id: "mono/a", block: block(0.0416, "USD") },
      { id: "mono/b", block: block(0.0312, "EUR") },
      { id: "team-a/a", block: block(0.0208, "USD") },
    ]);
    const meta = attachBehaviour(ir, members, "live", noFiles);
    expect(meta.sum).toBeUndefined();
    expect(meta.diagnostics).toEqual([
      "no estate sum: the figures are in EUR and USD and behold converts no currency",
      "no sum for box mono: the figures are in EUR and USD and behold converts no currency",
    ]);
    // The box whose figures agree still sums — the mixture is per scope.
    expect(meta.boxes).toEqual({ "team-a": { perHour: 0.0208, currency: "USD", priced: 1, unpriced: 0 } });
  });

  it("rounds the addition back to six decimals rather than shipping a float tail", () => {
    const ir = irOf(Array.from({ length: 21 }, (_, i) => ({ id: `mono/${i}`, block: block(0.0416) })));
    // 0.0416 * 21 in binary floating point is 0.8735999999999999.
    expect(attachBehaviour(ir, [members[0]], "live", noFiles).sum!.perHour).toBe(0.8736);
  });
});

describe("the source priority (#398 item 3)", () => {
  it("never reads the document for a member whose nodes already carry the attr", () => {
    const looked: string[] = [];
    const ir = irOf([{ id: "mono/a", block: block(0.0416) }, { id: "team-a/a" }]);
    const meta = attachBehaviour(ir, members, "live", (p) => {
      looked.push(p);
      return undefined;
    });
    // The monolith painted its own; only the silent member was looked up.
    expect(looked).toEqual(["/nowhere/team-a/behaviour.live.json"]);
    expect(meta.sum).toEqual({ perHour: 0.0416, currency: "USD", priced: 1, unpriced: 1 });
  });

  it("names the environment in the file it looks for", () => {
    const looked: string[] = [];
    attachBehaviour(irOf([{ id: "mono/a" }]), [members[0]], "staging", (p) => {
      looked.push(p);
      return undefined;
    });
    expect(looked).toEqual(["/nowhere/mono/behaviour.staging.json"]);
  });

  it("reports a document key that names no entity rather than minting a card", () => {
    const ir = irOf([{ id: "mono/a" }]);
    const doc = JSON.stringify({ meta: { engine: "e", version: "1", at: { traffic: "t" } }, entities: { ghost: block(1) } });
    const meta = attachBehaviour(ir, [members[0]], "live", () => doc);
    expect(ir.nodes.map((n) => n.id)).toEqual(["mono/a"]);
    expect(meta.diagnostics).toContain("mono: behaviour.live.json prices ghost, which this overlay has no entity for");
  });

  it("drops an unreadable document with its reason — an absence, not a refusal", () => {
    const meta = attachBehaviour(irOf([{ id: "mono/a" }]), [members[0]], "live", () => "{not json");
    // Nothing was priced, so the answer is still the absent line — with the
    // breakage named beside it rather than swallowed.
    expect(meta.absent).toContain("no report document at mono/behaviour.live.json");
    expect(meta.refusal).toBeUndefined();
    expect(meta.diagnostics?.[0]).toContain("mono: behaviour.live.json is not JSON");
  });

  it("names two engines rather than pretending one priced the estate", () => {
    const other = { ...block(0.02), provenance: { engine: "other-sim", version: "2.0", tolerance: "±20%", basis: "validated" as const } };
    const ir = irOf([{ id: "mono/a", block: block(0.0416) }, { id: "team-a/a", block: other }]);
    const meta = attachBehaviour(ir, [
      { name: "mono", dir: "/nowhere/mono", meta: { engine: "behold-fixture", version: "0", at: { traffic: "100 rps, p50" } } },
      { name: "team-a", dir: "/nowhere/team-a", meta: { engine: "other-sim", version: "2.0", at: { traffic: "100 rps, p50" } } },
    ], "live", noFiles);
    expect(meta.diagnostics).toContain("priced by 2 engines (behold-fixture 0, other-sim 2.0) — every figure carries its own provenance");
    // Every figure still carries its own badge, which is why the summary can
    // be a summary.
    expect((ir.nodes[1].attrs as { _behaviour: BehaviourBlock })._behaviour.provenance.engine).toBe("other-sim");
  });
});

describe("the validator (#398 item 1)", () => {
  const ok = block(0.01);

  it("accepts the contract's shape and rebuilds it, dropping whatever an engine appended", () => {
    const v = validateBehaviourBlock({ ...ok, futureField: "not in the contract" });
    expect(v.ok).toBe(true);
    expect(v.ok && v.value).not.toHaveProperty("futureField");
  });

  it("names the missing field", () => {
    const reason = (b: unknown): string => {
      const v = validateBehaviourBlock(b);
      return v.ok ? "accepted" : v.reason;
    };
    expect(reason({ ...ok, at: {} })).toContain("at.traffic missing");
    expect(reason({ ...ok, cost: { perHour: "0.04", currency: "USD" } })).toContain("cost.perHour");
    expect(reason({ ...ok, cost: { perHour: -1, currency: "USD" } })).toContain("negative");
    expect(reason({ ...ok, headroom: { cpu: 1.4 } })).toContain("headroom.cpu is not a fraction");
    expect(reason({ ...ok, resilience: { verdict: "survives" } })).toContain("resilience.failure missing");
    expect(reason({ ...ok, rightSize: { reason: "why" } })).toContain("rightSize present without a suggestion");
    expect(reason({ ...ok, provenance: { ...ok.provenance, basis: "guessed" } })).toContain("is not modeled/validated");
    expect(reason(null)).toBe("not an object");
  });

  it("keeps an axis the engine omitted omitted, and a note it wrote", () => {
    const v = validateBehaviourBlock({ ...ok, headroom: { latency: 0.4 }, resilience: { failure: "one zone lost", verdict: "degrades", note: "re-established" } });
    expect(v.ok && v.value.headroom).toEqual({ latency: 0.4 });
    expect(v.ok && v.value.resilience).toEqual({ failure: "one zone lost", verdict: "degrades", note: "re-established" });
  });

  it("takes a refusal on its own terms and requires a way forward", () => {
    expect(validateBehaviourMeta({ refusal: { reason: "unreachable", remedy: "set X" } })).toEqual({
      ok: true,
      value: { refusal: { reason: "unreachable", remedy: "set X" } },
    });
    const v = validateBehaviourMeta({ refusal: { reason: "unreachable" } });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toContain("refusal.remedy missing");
  });
});
