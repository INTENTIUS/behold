import { describe, it, expect } from "vitest";
import { releaseRows, runLink, unlinkedReason, runText } from "../web/release.js";

const NOW = Date.parse("2026-09-01T12:00:00Z");
const base = { runId: "18234771902", gitSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", digest: "sha256:86bf5e3c", timestamp: "2026-09-01T11:30:00Z", actor: "ci-bot" };

describe("release rows (#165)", () => {
  it("a record that carries its own address links the run, and names forge + repo", () => {
    const r = { ...base, forge: "github", originSource: "record", repo: "INTENTIUS/loomster", url: "https://github.com/INTENTIUS/loomster/actions/runs/18234771902", approver: "alex" };
    const rows = releaseRows(r, NOW);
    expect(rows[0]).toEqual(["run", { href: r.url, text: "18234771902 · GitHub Actions · INTENTIUS/loomster" }]);
    expect(rows.find(([k]) => k === "")).toBeUndefined();
    expect(rows.find(([k]) => k === "approver")[1]).toBe("alex");
    expect(rows.find(([k]) => k === "recorded")[1]).toBe("2026-09-01T11:30:00Z (30m ago)");
  });

  it("a bare id from a pre-chant#2045 record is never linked, and the caveat says why", () => {
    const r = { ...base, forge: "unknown", originSource: "inferred" };
    expect(runLink(r)).toBeNull();
    expect(unlinkedReason(r)).toMatch(/chant#2045/);
    expect(unlinkedReason(r)).toMatch(/will not guess/);
    expect(releaseRows(r, NOW)[0]).toEqual(["run", "18234771902 · an unlinked run"]);
  });

  it("a laptop run says there is nowhere to go — whether the record said local or the id's spelling did", () => {
    const said = { ...base, runId: "local-1756726200000", forge: "local", originSource: "record" };
    const spelled = { ...base, runId: "local-1756726200000", forge: "local", originSource: "inferred" };
    expect(unlinkedReason(said)).toMatch(/the record says so/);
    expect(unlinkedReason(spelled)).toMatch(/a local- id/);
    expect(runText(said)).toBe("local-1756726200000 · a laptop run");
  });

  it("an inferred origin never yields a link even if a url is somehow present", () => {
    expect(runLink({ ...base, forge: "github", originSource: "inferred", url: "https://example.com/run" })).toBeNull();
  });

  it("a recorded origin with a non-http url is not a link — the gate card's rule", () => {
    const r = { ...base, forge: "github", originSource: "record", url: "javascript:alert(1)" };
    expect(runLink(r)).toBeNull();
    expect(unlinkedReason(r)).toMatch(/named no server URL/);
  });

  it("an ungated change says so in the approver row rather than leaving a gap", () => {
    const rows = releaseRows({ ...base, forge: "op", originSource: "record" }, NOW);
    expect(rows.find(([k]) => k === "approver")[1]).toBe("none — an ungated change");
    expect(unlinkedReason({ ...base, forge: "op", originSource: "record" })).toMatch(/Temporal/);
  });

  it("nothing recorded → no rows", () => {
    expect(releaseRows(undefined)).toEqual([]);
  });
});
