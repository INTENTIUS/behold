import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { joinTerragucci, type CheckoutRoot } from "./terragucci-overlay.ts";
import { readTerragucci, INDEX_SCHEMA } from "./terragucci-reports.ts";
import { terragucciSource } from "./terragucci-source.ts";
// @ts-expect-error the kiosk's browser modules have no declaration files
import { cardLines, dependentsOf, lineState, planOf, selectLight, slotState, startKioskLight, stateMarks, stateWords, unknownSlots } from "../web/kiosk-light.js";
// @ts-expect-error see above
import { sceneModel } from "../web/kiosk-estate-scene.js";
// @ts-expect-error see above
import { pinnedAnswer } from "../web/terragucci-change.js";

// behold#940: a composed choudoufu run as terragucci writes it (report minor 48, `compose.estate`): three estates
// with no state files, and a checkout whose graph (no nodes here) holds none of the run's resources. The fixtures are
// src/__fixtures__/terragucci-demo-ask/report-estate-*.json: the pull request's plan, then the apply a person approved.
const FIX = join(import.meta.dirname, "__fixtures__", "terragucci-demo-ask");
const doc = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const ROOTS: CheckoutRoot[] = ["network", "app", "edge"].map((n) => ({ member: "demo", name: n, path: n }));
const SUBNET = "arn:aws:sqs:us-east-1:000000000000:choudoufu-compose-subnet";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function write(dir: string, path: string, body: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), JSON.stringify(body));
}
/** A report bucket: the plan, and the apply when `applied`. */
function bucket(applied: boolean): string {
  const d = mkdtempSync(join(tmpdir(), "behold-estate-scene-"));
  made.push(d);
  const project = "forge.example/demo/choudoufu-states";
  const rows = [{ project, commit: "c0ffee0000000000000000000000000000000001", stage: "tf-plan", finished: "2026-10-24T10:01:00.000Z", path: "p/plan", pull_request: "41" }] as Record<string, unknown>[];
  write(d, "p/plan/report.json", doc("report-estate-plan.json"));
  if (applied) {
    write(d, "p/apply/report.json", doc("report-estate-apply.json"));
    rows.push({ project, commit: "c0ffee0000000000000000000000000000000001", stage: "tf-apply", wave: 1, finished: "2026-10-24T10:05:00.000Z", path: "p/apply", approval: "approved", applied: "2026-10-24T10:05:00.000Z" });
  }
  write(d, "index.json", { schema: INDEX_SCHEMA, reports: rows });
  return d;
}
async function answerOf(applied: boolean) {
  const read = await readTerragucci(terragucciSource(bucket(applied)), { roots: ROOTS.map((r) => r.path) });
  const marks = joinTerragucci(read, [], ROOTS);
  return { ...marks, roots: marks.roots.map((r) => ({ member: r.member, name: r.name, path: r.path })), pull_request: read.pull_request };
}
const progressApplied = { states: [{ number: 1, state: "applied", roots: ["network", "app", "edge"], composed: { members: ["network", "app", "edge"].map((root) => ({ root, apply: "applied", state: "written" })) } }], reads: [] };

describe("a composed choudoufu run's scene (behold#940)", () => {
  it("lists each estate's planned resources from the plan report, with no node in the checkout's graph", async () => {
    const a = await answerOf(false);
    expect(a.unmatched.changes.length).toBeGreaterThan(0);
    expect(a.estateScene!.roots.map((r) => [r.path, r.resources.map((x) => `${x.address}:${x.state}`)])).toEqual([
      ["network", ["aws_sqs_queue.subnet:planned", "aws_sqs_queue.release:planned"]],
      ["app", ["aws_sqs_queue.security_group:planned", "aws_sqs_queue.route_table:planned", "aws_sqs_queue.instance:planned", "aws_sqs_queue.dns_record:planned"]],
      ["edge", ["aws_sqs_queue.dns_upstream:planned"]],
    ]);
  });

  it("lights the subnet and counts what depends on it", async () => {
    const a = await answerOf(false);
    const ask = { light: ["network/aws_sqs_queue.subnet"], paths: true };
    const sel = selectLight(planOf(a), ask);
    expect(sel.cardIds).toContain("demo/network/aws_sqs_queue.subnet");
    expect(sel.dependents).toBe(5);
    expect(dependentsOf(a, null, ask)).toBe(5);
    // Not the replaced release: it is in the scene, and not in the subnet's reach.
    expect(sel.lit).not.toContain("network/aws_sqs_queue.release");
  });

  it("marks app's unknown values as empty slots, filled with the value once the apply wrote it", async () => {
    const planned = await answerOf(false);
    const slots = unknownSlots(planOf(planned)).filter((s: { root: string }) => s.root === "app");
    expect(slots).toHaveLength(4);
    expect(slots[0]).toMatchObject({ path: "name", producer: "network/aws_sqs_queue.subnet" });
    const done = await answerOf(true);
    const slot = unknownSlots(planOf(done)).find((s: { address: string }) => s.address === "aws_sqs_queue.security_group");
    expect(slot).toBeTruthy();
    expect(slotState(slot, done, progressApplied)).toEqual({ filled: true, value: expect.stringContaining("choudoufu-compose-sg-") });
    // Before the producer applies, the slot is empty.
    expect(slotState(slot, done, null)).toEqual({ filled: false });
  });

  it("marks what applied once a newer apply report lists it", async () => {
    const a = await answerOf(true);
    expect(a.estateScene!.roots.flatMap((r) => r.resources).every((x) => x.state === "applied")).toBe(true);
    expect(a.applied["demo/network/aws_sqs_queue.subnet"]!.values).toEqual([{ address: "aws_sqs_queue.subnet", path: "arn", after: SUBNET }]);
  });

  it("says each estate's records written, not a state file", async () => {
    const a = await answerOf(true);
    const marks = stateMarks(a, progressApplied);
    expect(marks.network).toMatchObject({ estate: true, written: true, look: "applied" });
    expect(stateWords(marks.network)).toBe("network · applied · records written");
    // A plain root keeps its state file's words.
    expect(stateWords({ file: "app.tfstate", look: "applied", written: true })).toBe("state app.tfstate · applied · written");
  });

  it("is drawn as a stack: network on top, every card inside its box, room used", async () => {
    const a = await answerOf(false);
    const m = sceneModel(a, planOf(a), null, { width: 1900, height: 740 });
    expect(m.roots.map((r: { path: string }) => r.path)).toEqual(["network", "app", "edge"]);
    const [network, app, edge] = m.roots;
    expect(network.y).toBeLessThan(app.y);
    expect(app.y).toBeLessThan(edge.y);
    for (const r of m.roots) for (const c of r.cards) {
      expect(c.x).toBeGreaterThanOrEqual(r.x);
      expect(c.x + c.w).toBeLessThanOrEqual(r.x + r.w);
      expect(c.y).toBeGreaterThanOrEqual(r.y);
      expect(c.y + c.h).toBeLessThanOrEqual(r.y + r.h);
    }
    // The subnet's reach, to the root next to it: one edge to each of app's four, none past app's box to edge's.
    expect(m.edges.filter((e: { from: string }) => e.from === "demo/network/aws_sqs_queue.subnet")).toHaveLength(4);
    // Not one row of three: it is taller than the old layout and fills the wide room.
    expect(m.height).toBeGreaterThan(m.width / 4);
  });

  it("goes where the plan goes under a pin: none at the base", async () => {
    const a = await answerOf(false);
    expect(pinnedAnswer(a, "base").estateScene).toBeUndefined();
    expect(pinnedAnswer(a, "base").pull_request).toBeNull();
  });

  it("is absent on a plain composed run", async () => {
    const d = bucket(false);
    const plan = doc("report-estate-plan.json");
    delete plan.compose.estate;
    write(d, "p/plan/report.json", plan);
    const read = await readTerragucci(terragucciSource(d), { roots: ROOTS.map((r) => r.path) });
    expect(joinTerragucci(read, [], ROOTS).estateScene).toBeUndefined();
  });
});

// A real apply report of a create cycle (choudoufu-compose-create): network creates the subnet, app reads its id
// through data.terraform_estate_outputs.network, edge reads app's dns_name. The checkout here lists only app and edge,
// as a checkout whose network root is not found would: the scene still draws all three estates.
describe("a real composed create report (behold#940)", () => {
  const REAL = "report-chou-apply-real.json";
  function realBucket(): string {
    const d = mkdtempSync(join(tmpdir(), "behold-estate-real-"));
    made.push(d);
    const project = "forgejo:3000/terragucci-admin/demo-choudoufu-compose";
    const commit = "67377db0864a0f156829607e916d5afdcfb5771c";
    const apply = doc(REAL);
    const plan = { ...doc(REAL), run: { ...apply.run, stage: "tf-plan", pull_request: "41", finished: "2026-10-24T15:20:00.000Z" } };
    write(d, "p/plan/report.json", plan);
    write(d, "p/apply/report.json", apply);
    write(d, "index.json", {
      schema: INDEX_SCHEMA,
      reports: [
        { project, commit, stage: "tf-plan", finished: "2026-10-24T15:20:00.000Z", path: "p/plan", pull_request: "41" },
        { project, commit, stage: "tf-apply", wave: 1, finished: apply.run.finished, path: "p/apply", approval: "not-required", applied: apply.run.finished },
      ],
    });
    return d;
  }
  async function realAnswer(rootNames: string[]) {
    const roots: CheckoutRoot[] = rootNames.map((n) => ({ member: "demo", name: n, path: n }));
    const read = await readTerragucci(terragucciSource(realBucket()), { roots: roots.map((r) => r.path) });
    const marks = joinTerragucci(read, [], roots);
    return { ...marks, roots: marks.roots.map((r) => ({ member: r.member, name: r.name, path: r.path })), pull_request: read.pull_request };
  }
  const ASK = { light: ["network/aws_subnet.subnet"], paths: true };

  it("draws every estate the run names, the network one among them", async () => {
    for (const names of [["network", "app", "edge"], ["app", "edge"]]) {
      const a = await realAnswer(names);
      expect(a.estateScene!.roots.map((r) => r.path).sort()).toEqual(["app", "edge", "network"]);
      const m = sceneModel(a, planOf(a), null, { width: 390, height: 460 });
      expect(m.roots.map((r: { path: string }) => r.path)).toEqual(["network", "app", "edge"]);
      expect(m.roots[0].cards.map((c: { address: string }) => c.address)).toEqual(["aws_subnet.subnet"]);
    }
  });

  it("counts what depends on the subnet: app's four and edge's dns_upstream", async () => {
    const a = await realAnswer(["app", "edge"]);
    const sel = selectLight(planOf(a), ASK);
    expect(sel.seeds).toEqual(["network/aws_subnet.subnet"]);
    expect(sel.dependents).toBe(5);
    expect(dependentsOf(a, null, ASK)).toBe(5);
    expect(sel.lit).not.toContain("app/aws_sqs_queue.listener");
    expect(sel.lit).not.toContain("edge/aws_sqs_queue.upstream");
    expect(sel.lit).toContain("edge/aws_sqs_queue.dns_upstream");
  });

  it("shows a card at most two lines: the values read from another estate, never the attribute dump", async () => {
    const a = await realAnswer(["network", "app", "edge"]);
    const lines = cardLines(planOf(a));
    const by = (addr: string) => lines.filter((l: { address: string }) => l.address === addr).map((l: { path: string; kind: string }) => `${l.kind}:${l.path}`);
    expect(by("aws_network_interface.network_interface")).toEqual(["unknown:subnet_id"]);
    expect(by("aws_route_table.route_table")).toEqual(["unknown:vpc_id"]);
    expect(by("aws_security_group.security_group")).toEqual(["unknown:vpc_id"]);
    expect(by("aws_instance.instance")).toEqual(["unknown:subnet_id"]);
    expect(by("aws_subnet.subnet")).toEqual([]);
    for (const id of new Set(lines.map((l: { cardId: string }) => l.cardId))) expect(lines.filter((l: { cardId: string }) => l.cardId === id).length).toBeLessThanOrEqual(2);
    expect(lines).toHaveLength(4);
  });

  it("reads 'known after apply' while unknown and goes green once the network applied", async () => {
    const a = await realAnswer(["network", "app", "edge"]);
    const nic = cardLines(planOf(a)).find((l: { address: string }) => l.address === "aws_network_interface.network_interface");
    expect(lineState(nic, a, null)).toEqual({ state: "unknown", text: "subnet_id: known after apply" });
    const done = lineState(nic, a, progressApplied);
    expect(done.state).toBe("applied");
    expect(done.text).toContain("subnet_id");
  });

  it("shows a changed known value as before -> after", () => {
    const plan = {
      reads: [],
      reaches: new Map(),
      resources: new Map([["app/aws_sqs_queue.listener", { key: "app/aws_sqs_queue.listener", root: "app", address: "aws_sqs_queue.listener", cardId: "demo/app/aws_sqs_queue.listener", name: "listener", action: "update", values: [{ path: "port", before: 8080, after: 8090 }, { path: "tags", unknown: true, before: {} }, { path: "region", after: "x" }] }]]),
    };
    const lines = cardLines(plan);
    expect(lines).toHaveLength(1);
    expect(lineState(lines[0], null, null)).toEqual({ state: "changed", text: "port: 8080 -> 8090" });
  });

  it("lights on ask-done and on ask-status, and not on ask-start", async () => {
    const a = await realAnswer(["network", "app", "edge"]);
    const sent: { lit: boolean }[] = [];
    const handlers = new Map<string, (e: unknown) => void>();
    const win = { addEventListener: (t: string, f: (e: unknown) => void) => handlers.set(t, f), removeEventListener: () => {}, setTimeout: () => 0 };
    startKioskLight({ post: (m: { lit: boolean }) => sent.push(m), getAnswer: () => a, getProgress: () => null, win });
    handlers.get("behold:ask-start")!({ detail: { ask: ASK } });
    expect(sent).toHaveLength(0);
    expect((win as { beholdAskTokens?: unknown }).beholdAskTokens).toEqual({ dependents: 5 });
    handlers.get("behold:ask-done")!({ detail: { ask: ASK } });
    expect(sent.map((m) => m.lit)).toEqual([true]);
    handlers.get("behold:ask-status")!({ detail: { ask: { status: "Applying" } } });
    expect(sent.map((m) => m.lit)).toEqual([true, false]);
  });
});
