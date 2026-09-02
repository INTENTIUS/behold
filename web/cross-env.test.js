import { describe, it, expect } from "vitest";
import { comparisonRow, comparisonSummary } from "./cross-env.js";

const cmp = (over) => ({ component: "web", envA: "prod", envB: "staging", digestA: "sha256:aaaa1111bbbb2222", digestB: "sha256:aaaa1111bbbb2222", same: true, ...over });

describe("comparisonRow (#234 — is prod running what staging tested)", () => {
  it("same digest in both reads good, with the digest named", () => {
    const r = comparisonRow(cmp({}));
    expect(r).toMatchObject({ tone: "good", verdict: "same" });
    expect(r.detail).toContain("aaaa1111bbbb");
  });

  it("matching inputs with differing bytes says SAME INPUTS — never claims same bytes (pinned helm, chant#1243)", () => {
    const r = comparisonRow(cmp({
      digestA: "sha256:prod-bytes",
      digestB: "sha256:staging-bytes",
      same: true,
      comparedOn: { a: "sha256:inputs", b: "sha256:inputs" },
    }));
    expect(r.tone).toBe("good");
    expect(r.verdict).toBe("same inputs");
    expect(r.detail).toContain("rendered bytes differ per cluster");
  });

  it("differing identities read warn, both digests visible", () => {
    const r = comparisonRow(cmp({ digestB: "sha256:other", same: false }));
    expect(r).toMatchObject({ tone: "warn", verdict: "differs" });
    expect(r.detail).toContain("prod");
    expect(r.detail).toContain("staging");
  });

  it("a missing side is UNRECORDED (neutral) and names where — never painted as drift", () => {
    const r = comparisonRow(cmp({ digestB: undefined, same: false }));
    expect(r).toMatchObject({ tone: "neutral", verdict: "unrecorded" });
    expect(r.detail).toContain("staging");
    expect(comparisonRow(cmp({ digestA: undefined, digestB: undefined, same: false })).detail).toContain("prod or staging");
  });
});

describe("comparisonSummary", () => {
  const payload = (comparisons) => ({ env: "prod", to: "staging", comparisons });

  it("worst tone first: any differ makes the line warn with the count", () => {
    const s = comparisonSummary(payload([cmp({}), cmp({ component: "api", digestB: "sha256:x", same: false })]));
    expect(s).toEqual({ text: "1 of 2 differ from staging", tone: "warn" });
  });

  it("all same is the good line the question wants answered", () => {
    const s = comparisonSummary(payload([cmp({}), cmp({ component: "api" })]));
    expect(s).toEqual({ text: "all 2 running what staging tested", tone: "good" });
  });

  it("unrecorded components temper the claim instead of hiding in either count", () => {
    const s = comparisonSummary(payload([cmp({}), cmp({ component: "api", digestB: undefined, same: false })]));
    expect(s).toEqual({ text: "1 same as staging, 1 unrecorded", tone: "neutral" });
  });

  it("an empty ledger pair says so", () => {
    expect(comparisonSummary(payload([]))).toEqual({ text: "no components recorded in prod or staging", tone: "neutral" });
  });
});
