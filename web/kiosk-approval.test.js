// behold#571: "How this hold ends" lights its rows from records (the fixture runs approve as terragucci-admin): the ledger's
// requested and approved entries, the lane's seal check and applied record,
// and the cycle's runs' log lines. Never from the step the narration is at.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PANEL_STEPS, ROWS, approvalModel, inferBack, clockWords, cycleRuns, heldWave, rowFacts, sameDigest, sealWords, shortDigest } from "./kiosk-approval.js";

const FIX = join(import.meta.dirname, "..", "src", "__fixtures__", "terragucci-demo", "runs");
const run = (id) => JSON.parse(readFileSync(join(FIX, `${id}.json`), "utf8"));
const D2 = "jcs1-sha256:0accc105ba060b9974468c91def518039d935ad6629f8a15869f6e89ef748b61";
const demo = (step) => ({ step, cycle: 90, pull: 278, started_at: "2026-10-15T04:08:30Z", commit: "ef959409b8d590f4c3b05f0b7154cd576c9e1abf" });
const history = (kinds) => ({
  entries: [
    { kind: "approved", gate: "wave-2", at: "2026-10-15T04:10:08.707Z", digest: D2, actor: "terragucci-admin", seal: "sealed", audit: { sealed: true }, source: { commit: "4cba487a0000" } },
    { kind: "approval-requested", gate: "wave-2", at: "2026-10-15T04:09:41Z", digest: D2, source: { commit: "57869649aaaa" } },
    // An earlier cycle's approval of the same plan: the loop plans the same change every time.
    { kind: "approved", gate: "wave-2", at: "2026-10-15T03:56:09.124Z", digest: D2, actor: "terragucci-admin", seal: "sealed", source: { commit: "0ld" } },
  ].filter((e) => kinds.includes(e.kind)),
});
const lane = (over = {}) => ({ gates: [{ gate: "wave-2", approval: { by: "terragucci-admin", at: "2026-10-15T04:10:08.707Z", signed: true, sealCheck: { ok: true } }, ...over }] });
const state = (m) => Object.fromEntries(m.rows.map((r) => [r.id, r.state]));

describe("the approval panel (behold#571)", () => {
  it("shows from the wave waiting through the waves applied, and has four rows", () => {
    expect(PANEL_STEPS).toEqual(["waiting", "approved", "resumed", "applied"]);
    expect(ROWS.map((r) => r.label)).toEqual(["Requested", "Approved", "Resumed", "Spent"]);
    expect(approvalModel({ demo: demo("applying"), runs: [run(444)] })).toBe(null);
    expect(approvalModel({ demo: demo("waiting"), runs: [] })).toBe(null);
  });

  it("finds the held wave and its plan in the cycle's runs", () => {
    const cycle = cycleRuns([run(445), run(444), run(443), run(447)], demo("waiting"));
    expect(cycle.map((r) => r.id)).toEqual([444, 445]);
    const h = heldWave(cycle);
    expect(h).toMatchObject({ wave: 2, digest: D2, line: { run: 444, job: "apply-wave-2" } });
  });

  it("lights Requested at the hold, from the log line alone and then the ledger", () => {
    const m = approvalModel({ demo: demo("waiting"), runs: [run(444)], now: Date.parse("2026-10-15T04:09:50Z") });
    expect(state(m)).toEqual({ requested: "lit", approved: "dim", resumed: "dim", spent: "dim" });
    expect(m.rows[0].line.a.id).toBe("T11");
    const withLedger = approvalModel({ demo: demo("waiting"), runs: [run(444)], history: history(["approval-requested", "approved"]), now: Date.parse("2026-10-15T04:09:50Z") });
    // The approval at 04:10:08 is after the page's clock, so it is not there yet.
    expect(state(withLedger).approved).toBe("dim");
    expect(withLedger.rows[0].commit).toBe("57869649aaaa");
  });

  it("puts the driver's command in the Approved row until the approval is recorded", () => {
    const driver = { gloss: "Next the driver signs.", approve: "chant approve tf-apply wave-2", comment: "/terragucci apply", on: "pull request #278" };
    const m = approvalModel({ demo: demo("waiting"), runs: [run(444)], driver, now: Date.parse("2026-10-15T04:09:50Z") });
    expect(m.rows[1]).toMatchObject({ state: "dim", command: "chant approve tf-apply wave-2" });
  });

  it("lights Approved for exactly this plan, this cycle, with its seal checked", () => {
    const m = approvalModel({ demo: demo("approved"), runs: [run(444)], history: history(["approval-requested", "approved"]), lifecycle: lane(), now: Date.parse("2026-10-15T04:10:09Z") });
    expect(state(m)).toEqual({ requested: "lit", approved: "lit", resumed: "dim", spent: "dim" });
    expect(m.rows[1].text).toBe("terragucci-admin approved exactly this plan.");
    expect(m.rows[1].seal.ok).toBe(true);
    expect(m.rows[1].at).toBe("2026-10-15T04:10:08.707Z");
    // Only an earlier cycle's approval of the same digest: nothing lights.
    const old = approvalModel({ demo: demo("approved"), runs: [run(444)], history: { entries: history(["approved"]).entries.filter((e) => e.source.commit === "0ld") }, now: Date.parse("2026-10-15T04:10:09Z") });
    expect(state(old).approved).toBe("dim");
  });

  it("lights Resumed and Spent from the resume run's lines and the ledger's applied record", () => {
    const m = approvalModel({
      demo: demo("applied"),
      runs: [run(444), run(445)],
      history: history(["approval-requested", "approved"]),
      lifecycle: lane({ applied: { at: "2026-10-15T04:10:15Z", approvedAt: "2026-10-15T04:10:08.707Z", approvedBy: "terragucci-admin" } }),
      now: Date.parse("2026-10-15T04:11:00Z"),
    });
    expect(state(m)).toEqual({ requested: "lit", approved: "lit", resumed: "lit", spent: "lit" });
    expect(m.rows[2].line.a.id).toBe("T36");
    expect(m.rows[3].line).toMatchObject({ run: 445, a: { id: "T14" } });
    expect(m.rows[3].at).toBe("2026-10-15T04:10:15Z");
    expect(m.rows[1].line.a.id).toBe("T09");
  });

  it("says what the seal is", () => {
    expect(sealWords({ seal: "sealed" }, { ok: true }).ok).toBe(true);
    expect(sealWords({ seal: "sealed" }, { ok: false, reason: "no key" }).text).toMatch(/does not check out: no key$/);
    expect(sealWords({ seal: "sealed" }, null).ok).toBe(null);
    expect(sealWords({ seal: "unsigned" }, null).text).toBe("not signed");
  });

  it("reads digests and times the way the panel shows them", () => {
    expect(sameDigest(D2, `sha256:${D2.slice(12)}`)).toBe(true);
    expect(shortDigest(D2)).toBe("0accc105ba06");
    expect(clockWords("2026-10-15T04:10:08.707Z")).toBe("04:10:08");
    expect(rowFacts({ at: "2026-10-15T04:10:08Z", commit: "4cba487a0000", runId: 445 })).toEqual(["04:10:08", "ledger 4cba487a", "run #445"]);
  });

  it("never lights a row after one that is not lit", () => {
    const resumeless = { ...run(445), trigger: "merge", event: "push" };
    const inputs = {
      runs: [[run(444)], [run(444), run(445)], [run(444), resumeless], [run(445)]],
      history: [null, history(["approval-requested"]), history(["approval-requested", "approved"]), history(["approved"])],
      lifecycle: [null, lane(), lane({ applied: { at: "2026-10-15T04:10:15Z", approvedAt: "2026-10-15T04:10:08.707Z", approvedBy: "terragucci-admin" } })],
    };
    for (const step of PANEL_STEPS)
      for (const runs of inputs.runs)
        for (const h of inputs.history)
          for (const l of inputs.lifecycle) {
            const m = approvalModel({ demo: demo(step), runs, history: h, lifecycle: l, fallback: { wave: 2, digest: D2 }, now: Date.parse("2026-10-15T04:11:00Z") });
            if (!m) continue;
            const lit = m.rows.map((r) => r.state === "lit");
            expect(lit.findIndex((x, i) => x && i > 0 && !lit[i - 1]), `${step}: ${m.rows.map((r) => r.state).join(",")}`).toBe(-1);
          }
  });

  it("lights Resumed from the spend when no resume run was copied, says so, and invents no time", () => {
    const resumeless = { ...run(445), trigger: "merge", event: "push" };
    const m = approvalModel({ demo: demo("applied"), runs: [run(444), resumeless], now: Date.parse("2026-10-15T04:11:00Z") });
    expect(m.rows.map((r) => r.state)).toEqual(["lit", "lit", "lit", "lit"]);
    expect(m.rows[2]).toMatchObject({ inferred: true, runId: 445, at: null });
    expect(rowFacts(m.rows[2])).toEqual(["inferred from the rows after it", "run #445"]);
    expect(m.rows[1]).toMatchObject({ inferred: true, text: "terragucci-admin approved this plan." });
    expect(inferBack([{ id: "requested", state: "dim" }, { id: "approved", state: "dim" }], { wave: 2 }).map((r) => r.state)).toEqual(["dim", "dim"]);
  });
});
