import { describe, it, expect } from "vitest";
import { isAdoptable, extractPrUrl, LIVE_IMPORT_LEXICONS } from "./adopt.ts";

describe("isAdoptable", () => {
  it("is true for a foreign node on a live-import lexicon", () => {
    for (const lexicon of LIVE_IMPORT_LEXICONS) {
      expect(isAdoptable({ lexicon, attrs: { _status: "foreign" } })).toBe(true);
    }
  });

  it("is false for a managed or pending node (nothing to adopt)", () => {
    expect(isAdoptable({ lexicon: "aws", attrs: { _status: "managed" } })).toBe(false);
    expect(isAdoptable({ lexicon: "aws", attrs: { _status: "pending" } })).toBe(false);
    expect(isAdoptable({ lexicon: "aws" })).toBe(false); // no overlay status
  });

  it("is false for a foreign node with no live-import path", () => {
    expect(isAdoptable({ lexicon: "gitlab", attrs: { _status: "foreign" } })).toBe(false);
    expect(isAdoptable({ lexicon: "helm", attrs: { _status: "foreign" } })).toBe(false);
    expect(isAdoptable({ attrs: { _status: "foreign" } })).toBe(false); // no lexicon
  });
});

describe("extractPrUrl", () => {
  it("pulls a GitHub PR URL from an outcome line", () => {
    expect(extractPrUrl("    [outcome] PR=https://github.com/acme/infra/pull/42")).toBe(
      "https://github.com/acme/infra/pull/42",
    );
  });

  it("pulls a GitLab merge-request URL", () => {
    expect(extractPrUrl("opened https://gitlab.com/acme/infra/-/merge_requests/7 for review")).toBe(
      "https://gitlab.com/acme/infra/-/merge_requests/7",
    );
  });

  it("returns undefined for a line with no PR URL", () => {
    expect(extractPrUrl("[phase] Reconcile")).toBeUndefined();
    expect(extractPrUrl("https://github.com/acme/infra/tree/main")).toBeUndefined();
  });
});
