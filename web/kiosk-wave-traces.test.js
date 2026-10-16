// behold#571: each wave's trace for Watch: which trace is a wave's, its
// phases as bars, the "trace ready" line, and the applied card's rows.
import { describe, expect, it } from "vitest";
import { miniWaterfall, msShort, phaseBars, phaseWords, traceReadyWords, waveTraces } from "./kiosk-wave-traces.js";

const span = (id, parent, start, ms, attrs = {}, name = id) => ({ id, parent, name, service: "terragucci", start, ms, attrs });
const trace = (wave, start, phases, job = `apply-wave-${wave}`) => {
  const ms = phases.reduce((a, p) => a + p.ms, 0);
  let t = start;
  const spans = [span(`root${wave}`, null, start, ms, { "terragucci.stage": "tf-apply", "terragucci.wave": wave })];
  for (const p of phases) {
    spans.push(span(`${p.phase}${wave}`, `root${wave}`, t, p.ms, { "terragucci.phase": p.phase, ...(p.held ? { "terragucci.gate.held_seconds": p.held } : {}) }));
    t += p.ms;
  }
  return { wave, job, start, ms, spans };
};

describe("wave traces: whose trace is it", () => {
  it("keeps each wave's newest trace across the cycle's runs, a resumed run's job applying several waves", () => {
    const merge = { run: "4855", traces: [trace(1, 1000, [{ phase: "plan", ms: 400 }]), trace(2, 2000, [{ phase: "plan", ms: 300 }])] };
    const resume = { run: "4856", traces: [trace(2, 9000, [{ phase: "plan", ms: 200 }], "apply-comment")] };
    const w = waveTraces([merge, resume, { error: "no tempo" }, null]);
    expect(Object.keys(w)).toEqual(["1", "2"]);
    expect(w[1]).toMatchObject({ run: "4855", job: "apply-wave-1" });
    expect(w[2]).toMatchObject({ run: "4856", job: "apply-comment" });
  });
});

describe("wave traces: the phases", () => {
  it("lays the stage's phases out in time, and splits a gate's hold from its check", () => {
    const t = trace(2, 0, [{ phase: "plan", ms: 1000 }, { phase: "gate", ms: 26_000, held: 25 }, { phase: "apply", ms: 2000 }, { phase: "report", ms: 500 }, { phase: "upload", ms: 500 }]);
    const bars = phaseBars(t);
    expect(bars.map((b) => [b.phase, b.ms, b.wait])).toEqual([["plan", 1000, false], ["held", 25_000, true], ["gate", 1000, false], ["apply", 2000, false], ["report", 500, false], ["upload", 500, false]]);
    expect(bars[1].at).toBeCloseTo(1000 / 30_000);
    expect(bars.reduce((a, b) => a + b.width, 0)).toBeCloseTo(1);
    expect(bars.map(phaseWords)).toEqual(["plan 1 s", "held 25 s for an approval", "gate 1 s", "apply 2 s", "report 500 ms", "upload 500 ms"]);
    expect(phaseBars({ spans: [] })).toEqual([]);
  });

  it("says what a trace shows: the hold when an approval held the wave, else its longest phase", () => {
    expect(traceReadyWords(2, trace(2, 0, [{ phase: "plan", ms: 1200 }, { phase: "apply", ms: 400 }]))).toBe("wave 2's trace is ready; it took 1.6 s, 1.2 s of it in the plan");
    expect(traceReadyWords(2, trace(2, 0, [{ phase: "plan", ms: 1000 }, { phase: "gate", ms: 26_000, held: 25 }]))).toBe("wave 2's trace is ready; it took 27 s, 25 s of it held for an approval");
    expect(traceReadyWords(2, null)).toBeNull();
    expect([msShort(70), msShort(1600), msShort(48_400), msShort(125_000)]).toEqual(["70 ms", "1.6 s", "48 s", "2 min 5 s"]);
  });

  it("gives the applied card one row per wave that has a trace, and none for one that hasn't", () => {
    const w = waveTraces([{ run: "1", traces: [trace(3, 0, [{ phase: "apply", ms: 900 }]), trace(1, 0, [{ phase: "plan", ms: 300 }])] }]);
    const rows = miniWaterfall(w);
    expect(rows.map((r) => [r.wave, r.words, r.bars.length])).toEqual([[1, "300 ms", 1], [3, "900 ms", 1]]);
    expect(miniWaterfall({})).toEqual([]);
  });
});
