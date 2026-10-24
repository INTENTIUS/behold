import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bare, cardTitle, dependentsOf, lightMessage, planOf, producerOf, selectLight, slotState, startKioskLight, stateFile, stateMarks, unknownSlots } from "./kiosk-light.js";

// The three-root estate of behold#937 (src/__fixtures__/terragucci-demo-ask): network creates a subnet,
// app puts four resources in it, edge reads an address of app's. The answer is built the way the
// overlay builds /api/terragucci from the report: one card per changed resource, a mark on each.
const FIX = join(import.meta.dirname, "..", "src", "__fixtures__", "terragucci-demo-ask");
const read = (f) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const report = read("report-pull-request.json");

function answerOf(r) {
  const roots = r.roots.map((x) => ({ member: "demo", name: x.path, path: x.path }));
  const cards = {};
  for (const root of r.roots) {
    for (const c of root.changes) {
      cards[`demo/${root.path}/${c.address}`] = [{ verdict: "plan", action: c.action, addresses: [c.address], values: (c.attributes || []).map((a) => ({ ...a, address: c.address })) }];
    }
  }
  const reads = r.roots.flatMap((x) => (x.reads || []).map((rd) => ({ ...rd, root: x.path })));
  return { roots, cards, unmatched: { roots: [], changes: [] }, pull_request: { roots: r.roots.map((x) => x.path), reads, blast: r.blast, waves: r.waves } };
}
const answer = answerOf(report);
const progressOf = (run) => ({ states: run.waves.map((w) => ({ number: w.number, state: w.state, roots: w.roots, composed: w.composed })), reads: run.roots.map((x) => ({ root: x.root, wave: x.wave, reads: x.reads, stateKey: x.state && x.state.key })) });

describe("which resources a step lights (behold#937)", () => {
  const plan = planOf(answer);

  it("reads the changed resources as <root>/<address>, with the card each is", () => {
    expect([...plan.resources.keys()].sort()).toEqual(["app/terraform_data.queue", "app/terraform_data.schedule", "app/terraform_data.service", "app/terraform_data.worker", "edge/terraform_data.route", "network/terraform_data.subnet"]);
    expect(plan.resources.get("network/terraform_data.subnet")).toMatchObject({ cardId: "demo/network/terraform_data.subnet", name: "subnet", type: "terraform_data", action: "create" });
    expect(plan.edges).toEqual([{ from: "network", to: "app" }, { from: "app", to: "edge" }]);
  });

  it("lights the named nodes alone when the step has no paths", () => {
    const sel = selectLight(plan, { light: ["network/terraform_data.subnet"] });
    expect(sel).toMatchObject({ seeds: ["network/terraform_data.subnet"], dependents: 0, cardIds: ["demo/network/terraform_data.subnet"], roots: ["network"] });
  });

  it("follows the reads and the blast radius downstream with paths, and counts what depends on the seed", () => {
    const sel = selectLight(plan, { light: ["network/terraform_data.subnet"], paths: true });
    expect(sel.dependents).toBe(5);
    expect(sel.lit.sort()).toEqual([...plan.resources.keys()].sort());
    expect(sel.cardIds).toHaveLength(6);
    expect(sel.roots.sort()).toEqual(["app", "edge", "network"]);
  });

  it("lights only what is downstream of a seed in the middle", () => {
    const sel = selectLight(plan, { light: ["app/terraform_data.service"], paths: true });
    expect(sel.roots.sort()).toEqual(["app", "edge"]);
    expect(sel.lit).toContain("edge/terraform_data.route");
    expect(sel.lit).not.toContain("network/terraform_data.subnet");
    expect(selectLight(plan, { light: ["edge/terraform_data.route"], paths: true }).dependents).toBe(0);
  });

  it("skips an address that matches nothing, never an error, and lights nothing when none match", () => {
    const sel = selectLight(plan, { light: ["network/terraform_data.nope", "network/terraform_data.subnet"] });
    expect(sel.skipped).toEqual(["network/terraform_data.nope"]);
    expect(sel.seeds).toEqual(["network/terraform_data.subnet"]);
    expect(selectLight(plan, { light: ["network/terraform_data.nope"], paths: true })).toBeNull();
    expect(selectLight(plan, { prompt: "x" })).toBeNull();
    expect(selectLight(plan, null)).toBeNull();
    expect(selectLight(planOf(null), { light: ["a/b"] })).toBeNull();
  });

  it("matches an address with or without its instance key", () => {
    const withKey = planOf({ ...answer, cards: { ...answer.cards, "demo/app/terraform_data.service": [{ verdict: "plan", action: "create", addresses: ['terraform_data.service["a"]'], values: [] }] } });
    expect(selectLight(withKey, { light: ["app/terraform_data.service"] }).seeds).toEqual(['app/terraform_data.service["a"]']);
    expect(bare('x.y["a.b"]')).toBe("x.y");
  });

  it("gives {dependents} only for a step with paths", () => {
    expect(dependentsOf(answer, null, { light: ["network/terraform_data.subnet"], paths: true })).toBe(5);
    expect(dependentsOf(answer, null, { light: ["network/terraform_data.subnet"], paths: true, reply: "x" })).toBe(5);
    expect(dependentsOf(answer, null, { light: ["network/terraform_data.subnet"] })).toBeNull();
    expect(dependentsOf(answer, null, { light: ["nope/x"], paths: true })).toBe(0);
  });

  it("counts a change that has no card yet (a resource the checkout does not declare)", () => {
    const a = { ...answer, cards: {}, unmatched: { roots: [], changes: [{ root: "network", address: "terraform_data.subnet", action: "create", verdict: "plan" }, { root: "app", address: "terraform_data.service", action: "create", verdict: "plan" }, { root: "app", address: "terraform_data.old", action: "update", verdict: "drift" }] } };
    const sel = selectLight(planOf(a), { light: ["network/terraform_data.subnet"], paths: true });
    expect(sel).toMatchObject({ dependents: 1, cardIds: [] });
  });

  it("names a card by its resource first and its type second", () => {
    expect(cardTitle("terraform_data.subnet")).toEqual({ name: "subnet", type: "terraform_data" });
    expect(cardTitle('module.m.aws_s3_bucket.logs["eu"]')).toEqual({ name: 'logs["eu"]', type: "aws_s3_bucket" });
    expect(cardTitle("data.terraform_remote_state.network")).toEqual({ name: "network", type: "terraform_remote_state" });
  });
});

describe("the pane's events (behold#936 and behold#937)", () => {
  const fake = () => {
    const t = new EventTarget();
    t.sent = [];
    return t;
  };
  const ev = (type, ask) => new CustomEvent(type, { detail: { ask, step: "planned", scenario: "compose-create" } });

  it("sets the tokens at ask-start, lights at ask-done and clears at ask-clear", () => {
    const win = fake();
    const sent = [];
    startKioskLight({ post: (m) => sent.push(m), getAnswer: () => answer, getProgress: () => null, win });
    const ask = { prompt: "Show me", light: ["network/terraform_data.subnet"], paths: true, ghost: false };
    win.dispatchEvent(ev("behold:ask-start", ask));
    expect(win.beholdAskTokens).toEqual({ dependents: 5 });
    expect(sent).toEqual([]);
    win.dispatchEvent(ev("behold:ask-done", ask));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "behold:light", labels: true, lit: true, ghost: false });
    expect(sent[0].ids).toHaveLength(6);
    win.dispatchEvent(ev("behold:ask-clear", null));
    expect(sent[1]).toMatchObject({ lit: false, ids: [], ghost: false });
    expect(win.beholdAskTokens).toEqual({});
    expect(sent[1].token).not.toBe(sent[0].token);
  });

  it("clears the lighting on a beat without light, and passes the ghost through", () => {
    const win = fake();
    const sent = [];
    startKioskLight({ post: (m) => sent.push(m), getAnswer: () => answer, getProgress: () => null, win });
    win.dispatchEvent(ev("behold:ask-done", { prompt: "Now", ghost: true }));
    expect(sent[0]).toMatchObject({ lit: false, ghost: true });
    win.dispatchEvent(ev("behold:ask-start", { prompt: "Now" }));
    expect(win.beholdAskTokens).toEqual({});
  });

  it("lights the moment its reads are in: asks again soon rather than waiting for a poll (behold#940)", () => {
    const win = fake();
    const timers = [];
    win.setTimeout = (fn, ms) => timers.push({ fn, ms });
    const sent = [];
    let held = { roots: answer.roots, cards: {}, unmatched: { roots: [], changes: [] } };
    startKioskLight({ post: (m) => sent.push(m), getAnswer: () => held, getProgress: () => null, win });
    win.dispatchEvent(ev("behold:ask-done", { light: ["network/terraform_data.subnet"], paths: true }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ lit: false });
    expect(timers).toHaveLength(1);
    // The reads arrive; the next look lights, and stops looking.
    held = answer;
    timers.shift().fn();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ lit: true });
    expect(sent[1].token).not.toBe(sent[0].token);
    expect(timers).toHaveLength(0);
  });

  it("stops looking when a newer beat has come (behold#940)", () => {
    const win = fake();
    const timers = [];
    win.setTimeout = (fn, ms) => timers.push({ fn, ms });
    const sent = [];
    startKioskLight({ post: (m) => sent.push(m), getAnswer: () => ({ roots: answer.roots, cards: {}, unmatched: { roots: [], changes: [] } }), getProgress: () => null, win });
    win.dispatchEvent(ev("behold:ask-done", { light: ["network/terraform_data.subnet"] }));
    win.dispatchEvent(ev("behold:ask-clear", null));
    const before = sent.length;
    timers.shift().fn();
    expect(sent).toHaveLength(before);
  });

  it("tells a frame that reloaded the last message when it has drawn", () => {
    const win = fake();
    const sent = [];
    startKioskLight({ post: (m) => sent.push(m), getAnswer: () => answer, getProgress: () => null, win });
    win.dispatchEvent(new MessageEvent("message", { data: { type: "behold:drawn" } }));
    expect(sent).toEqual([]);
    win.dispatchEvent(ev("behold:ask-done", { light: ["network/terraform_data.subnet"] }));
    win.dispatchEvent(new MessageEvent("message", { data: { type: "behold:drawn" } }));
    expect(sent).toHaveLength(2);
    expect(lightMessage(null, null, 3)).toMatchObject({ lit: false, ids: [], roots: [] });
  });
});

describe("each state's file, written mark and look (behold#937)", () => {
  it("names a state by its backend key from run.json, else from the root's path", () => {
    const p = progressOf(read("run-applied.json"));
    expect(stateFile("network", p)).toEqual({ file: "network/terraform.tfstate", from: "run" });
    expect(stateFile("network", null)).toEqual({ file: "network.tfstate", from: "path" });
    expect(stateFile("envs/prod/app", { reads: [] })).toEqual({ file: "app.tfstate", from: "path" });
  });

  it("marks every state written and applied when the run applied", () => {
    const m = stateMarks(answer, progressOf(read("run-applied.json")));
    for (const root of ["network", "app", "edge"]) expect(m[root]).toMatchObject({ written: true, look: "applied" });
  });

  it("gives a failed composed run three looks: applied, partly applied, not applied", () => {
    const m = stateMarks(answer, progressOf(read("run-failed.json")));
    expect(m.network).toMatchObject({ look: "applied", written: true });
    expect(m.app).toMatchObject({ look: "partial", written: true });
    expect(m.edge).toMatchObject({ look: "not-applied", written: false });
  });

  it("shows no look and no mark while the apply has not ended or has not started", () => {
    for (const f of ["run-applying.json", "run-waiting.json"]) {
      const m = stateMarks(answer, progressOf(read(f)));
      for (const root of ["network", "app", "edge"]) expect(m[root]).toMatchObject({ look: null, written: false });
    }
  });

  it("labels the states from the path before any run exists", () => {
    const m = stateMarks(answer, null);
    expect(m.app).toMatchObject({ file: "app.tfstate", from: "path", written: false, look: null });
  });
});

describe("the unknown slot and its filling (behold#937)", () => {
  const plan = planOf(answer);

  it("marks app's inputs as not known until the subnet exists", () => {
    const slots = unknownSlots(plan);
    const app = slots.filter((s) => s.root === "app");
    expect(app.map((s) => s.address).sort()).toEqual(["terraform_data.queue", "terraform_data.schedule", "terraform_data.service", "terraform_data.worker"]);
    for (const s of app) expect(s).toMatchObject({ path: "input", producer: "network/terraform_data.subnet", text: "not known until subnet exists" });
    // The subnet's own id is a slot it fills itself; a known before and after (edge's route) is no slot.
    expect(slots.find((s) => s.root === "network")).toMatchObject({ path: "output", producer: "network/terraform_data.subnet" });
    expect(slots.some((s) => s.root === "edge")).toBe(false);
    expect(producerOf(plan, plan.resources.get("network/terraform_data.subnet")).key).toBe("network/terraform_data.subnet");
  });

  it("falls back to the created resource of the root it reads when the report has no blast radius", () => {
    const a = { ...answer, pull_request: { ...answer.pull_request, blast: undefined } };
    const p = planOf(a);
    expect(unknownSlots(p).find((s) => s.address === "terraform_data.worker").producer).toBe("network/terraform_data.subnet");
  });

  it("is empty until the producer's root has applied, then filled with no value when only run.json says so", () => {
    const slot = unknownSlots(plan).find((s) => s.root === "app");
    expect(slotState(slot, answer, progressOf(read("run-waiting.json")))).toEqual({ filled: false });
    expect(slotState(slot, answer, progressOf(read("run-applying.json")))).toEqual({ filled: false });
    expect(slotState(slot, answer, progressOf(read("run-applied.json")))).toEqual({ filled: true });
  });

  it("shows the applied value when an apply-time report states one", () => {
    const slot = unknownSlots(plan).find((s) => s.address === "terraform_data.service");
    const a = { ...answer, applied: { [slot.cardId]: { values: [{ path: "input", after: "subnet-0a1b", address: slot.address }], run: {} } } };
    expect(slotState(slot, a, progressOf(read("run-applied.json")))).toEqual({ filled: true, value: "subnet-0a1b" });
    expect(slotState(slot, a, progressOf(read("run-applying.json")))).toEqual({ filled: false });
  });

  it("finds no applied value in the fixtures' run.json or apply report (recorded on behold#937)", () => {
    const run = read("run-applied.json");
    expect(JSON.stringify(run)).not.toMatch(/"(after|value|values|outputs)"/);
    const apply = read("../terragucci-demo-composed/report-apply-wave-1-failed.json");
    for (const r of apply.roots) for (const c of r.changes) for (const at of c.attributes || []) if (at.unknown === true) expect(at).not.toHaveProperty("after");
  });
});
