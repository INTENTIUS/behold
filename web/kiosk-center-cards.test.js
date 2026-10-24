// The ask-mode scene is centred in the graph area, a card's lines follow the rules, and a composed run never counts waves.
import { describe, expect, it } from "vitest";
import { cardLines, composedRun, lineState, planOf } from "./kiosk-light.js";
import { askLayout } from "./kiosk-ask-layout.js";
import { shotViewBox } from "./kiosk-shot.js";
import { resultModel } from "./kiosk-watch.js";
import { ehSnapshot, cycleFacts } from "./kiosk-event-help.js";
import { metricsModel, steadyModel } from "./kiosk-metrics.js";

const scene = (extra = {}) => ({
  roots: [{ path: "network", member: "demo", name: "network" }, { path: "app", member: "demo", name: "app" }],
  cards: {},
  estateScene: {
    roots: [
      { path: "network", member: "demo", name: "network", resources: [{ address: "aws_subnet.subnet_b", action: "create", values: [{ path: "id", unknown: true }, { path: "assign_ipv6_address_on_creation", before: null, after: false }, { path: "cidr_block", before: null, after: "10.0.2.0/24" }] }] },
      { path: "app", member: "demo", name: "app", resources: [{ address: "aws_network_interface.worker", action: "create", values: [{ path: "id", unknown: true }, { path: "subnet_id", unknown: true }] }, { address: "aws_security_group.web", action: "replace", values: [{ path: "description", before: "old", after: "new" }, { path: "name", before: "a", after: "b" }, { path: "vpc_id", before: "v1", after: "v2" }] }] },
    ],
  },
  pull_request: { reads: [{ root: "app", upstream: "network", unknown: ["subnet_id"] }], upstreams: {} },
  ...extra,
});
const at = (lines, address) => lines.filter((l) => l.address === address).map((l) => `${l.kind}:${l.path}`);

describe("a card's lines (rules in order, at most two)", () => {
  it("leads with id for a created resource, never shows a false default", () => {
    const lines = cardLines(planOf(scene()));
    expect(at(lines, "aws_subnet.subnet_b")).toEqual(["unknown:id"]);
    expect(lines.some((l) => l.path === "assign_ipv6_address_on_creation")).toBe(false);
  });
  it("puts id, then the cross-estate read, then changes; two lines at most", () => {
    const lines = cardLines(planOf(scene()));
    expect(at(lines, "aws_network_interface.worker")).toEqual(["unknown:id", "unknown:subnet_id"]);
    expect(at(lines, "aws_security_group.web")).toHaveLength(2);
    expect(at(lines, "aws_security_group.web").every((l) => l.startsWith("changed:"))).toBe(true);
  });
  it("shows the real value once applied, and 'filled from' only when the report states none", () => {
    const a = scene();
    const plan = planOf(a);
    const sub = cardLines(plan).find((l) => l.address === "aws_network_interface.worker" && l.path === "subnet_id");
    const applied = { states: [{ number: 1, state: "applied", roots: ["network", "app"], composed: { members: [{ root: "network", apply: "applied", state: "written" }, { root: "app", apply: "applied", state: "written" }] } }] };
    expect(lineState(sub, a, null)).toEqual({ state: "unknown", text: "subnet_id: known after apply" });
    expect(lineState(sub, a, applied)).toEqual({ state: "applied", text: "subnet_id: filled from subnet_b" });
    const wrote = { ...a, applied: { "demo/app/aws_network_interface.worker": { values: [{ path: "subnet_id", after: "subnet-123" }] }, "demo/network/aws_subnet.subnet_b": { values: [{ path: "id", after: "subnet-123" }] } } };
    expect(lineState(sub, wrote, applied)).toEqual({ state: "applied", text: "subnet_id: subnet-123" });
    const id = cardLines(plan).find((l) => l.address === "aws_subnet.subnet_b");
    expect(lineState(id, wrote, applied)).toEqual({ state: "applied", text: "id: subnet-123" });
  });
});

describe("the fit centres the scene in the graph area", () => {
  const room = (w, h) => ({ width: w, height: h });
  const stack = () => askLayout([{ id: "n", cards: [{ id: "n1", w: 340, h: 90 }] }, { id: "a", cards: ["a", "b", "c", "d"].map((k) => ({ id: k, w: 340, h: 90 })) }, { id: "e", cards: [{ id: "e1", w: 340, h: 90 }, { id: "e2", w: 340, h: 90 }] }], room(1366, 520));
  it("centres each box on the widest, so unequal boxes do not hug the left", () => {
    const l = stack();
    const widest = Math.max(...Object.values(l.boxes).map((b) => b.w));
    for (const b of Object.values(l.boxes)) expect(b.x + b.w / 2).toBeCloseTo(l.width / 2, 0);
    expect(widest).toBe(l.width);
    for (const [id, c] of Object.entries(l.cards)) expect(c.x).toBeGreaterThanOrEqual(0 + 18 - 0.01 + (id ? 0 : 0));
  });
  it.each([[1366, 768, 520], [1920, 1080, 700], [390, 844, 440]])("puts the stack's centre on the open area's centre at %ix%i", (w, h, open) => {
    const l = stack();
    const target = { x: 0, y: 0, x2: l.width, y2: l.height };
    const pane = { width: w, height: open };
    const vb = shotViewBox(target, pane, { top: 40, right: 0, bottom: 0, left: 0 });
    const s = pane.width / vb[2];
    const cx = (vb[0] + vb[2] / 2 - (target.x + target.x2) / 2) * s;
    expect(Math.abs(cx)).toBeLessThan(1);
    // vertical: the target's centre sits at the middle of what is below the 40px inset.
    const cy = ((target.y + target.y2) / 2 - vb[1]) * s;
    expect(cy).toBeCloseTo(40 + (open - 40) / 2, 0);
  });
});

describe("the event help's applied line", () => {
  it("says one apply for a composed run, all N waves otherwise", () => {
    const run = (composed) => ({ run: { present: true, commit: "c1" }, states: [1, 2, 3].map((n) => ({ number: n, state: "applied", roots: [], ...(composed && n === 1 ? { composed: { members: [] } } : {}) })), reads: [] });
    const d = { cycle: 1, step: "applied", commit: "c1", label: "x", pull: null };
    const text = (p) => cycleFacts(ehSnapshot({ demo: d, progress: p })).find((f) => f.kind === "applied").text;
    expect(text(run(true))).toBe("applied together in one apply");
    expect(text(run(false))).toBe("all 3 waves applied");
  });
});

describe("a composed run never counts or names waves", () => {
  const composedProgress = { run: { present: true, commit: "c1" }, states: [1, 2, 3].map((n) => ({ number: n, state: "applied", roots: [], totals: {}, ...(n === 1 ? { composed: { members: [] } } : {}) })) };
  const demo = { step: "applied", cycle: 1, commit: "c1", label: "Applied." };
  it("reads as one apply", () => {
    const m = resultModel(demo, null, composedProgress);
    expect(m.counts[0]).toBe("applied together in one apply");
    expect(m.waves).toEqual([]);
    expect(m.counts.join(" ")).not.toMatch(/wave/i);
  });
  it("keeps waves for a run that is not composed", () => {
    const plain = { ...composedProgress, states: composedProgress.states.map(({ composed, ...w }) => w) };
    expect(resultModel(demo, null, plain).counts[0]).toBe("3 waves applied");
  });
  it("detects compose.estate, compose.roots and a scene", () => {
    expect(composedRun({ compose: { estate: true } })).toBe(true);
    expect(composedRun({ pull_request: { compose: { roots: ["a", "b"] } } })).toBe(true);
    expect(composedRun({ roots: [] }, null)).toBe(false);
  });
  it("the metrics count does not count waves", () => {
    const answer = { compose: { estate: true }, run: { current: true, waves: [{ wave: 1, seconds: 3, roots: [] }, { wave: 2, seconds: 1, roots: [] }] } };
    const m = metricsModel(answer);
    expect(m.count).not.toMatch(/wave/i);
    expect(steadyModel(m, { ...m, count: "x" }, { same: true }).count).not.toMatch(/wave/i);
    const plain = metricsModel({ run: answer.run });
    expect(plain.count).toBe("2 waves");
  });
});
