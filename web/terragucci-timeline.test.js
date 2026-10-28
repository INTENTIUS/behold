import { describe, it, expect } from "vitest";
import { actionOf, entryLine, laneLegend, laneRows, rootOfCard, runUrlOf, toneOf } from "./terragucci-timeline.js";

// #506: the lane's words, from answers shaped like /api/terragucci/timeline.
const NOW = new Date("2026-10-08T13:31:00Z");
const answer = {
  project: "github.com/acme/shop",
  files: "/api/terragucci/file?key=",
  record: { key: "audit.jsonl", present: true },
  total: 3,
  limit: 200,
  entries: [
    { id: "c", kind: "apply", at: "2026-10-08T09:31:00.000Z", who: null, what: "wave-2", wave: 2, digest: "jcs1-sha256:2e0fba16ce38925adf41", result: "waiting", roots: ["envs/staging/orders"], run: { report: "github.com/acme/shop/r2/report.html", job_url: "https://ci/9131" }, evidence: { source: "report" } },
    { id: "b", kind: "approval", at: "2026-10-08T09:20:00.000Z", who: "dana", what: "wave-1", digest: null, result: "unsigned", roots: ["envs/dev/orders"], run: {}, evidence: { source: "ledger", url: "https://github.com/acme/shop/commit/7f1e" } },
    { id: "a", kind: "refused", at: "2026-10-06T09:00:00.000Z", who: "lee", what: "wave-1", digest: null, result: "changed-after-approval", roots: ["envs/dev/orders"], run: {}, evidence: { source: "report" } },
  ],
};

describe("the timeline lane (#506)", () => {
  it("words an entry by its kind, who and result", () => {
    expect(entryLine(answer.entries[0])).toBe("apply wave-2: waiting · plan 2e0fba16ce38");
    expect(entryLine(answer.entries[1])).toBe("approved wave-1 by dana");
  });

  it("draws refusals and failures as failed, waits as pending", () => {
    expect(answer.entries.map(toneOf)).toEqual(["wave", "ok", "failed"]);
    expect(toneOf({ kind: "approval-revoked", result: "revoked" })).toBe("drift");
  });

  it("dates every row and links its report through the file route, its job and its ledger commit", () => {
    const rows = laneRows(answer, { now: NOW });
    expect(rows.map((r) => r.when)).toEqual(["09:31 UTC, 4h ago", "09:20 UTC, 4h ago", "2026-10-06 09:00 UTC, 2d ago"]);
    expect(rows[0].links).toEqual([
      { text: "report", href: "/api/terragucci/file?key=github.com%2Facme%2Fshop%2Fr2%2Freport.html" },
      { text: "job", href: "https://ci/9131" },
    ]);
    expect(rows[1].links).toEqual([{ text: "ledger commit", href: "https://github.com/acme/shop/commit/7f1e" }]);
    // In an export the key is relative to the bucket.
    expect(laneRows({ ...answer, files: "../../" }, { now: NOW })[0].links[0].href).toBe("../../github.com/acme/shop/r2/report.html");
  });

  it("keeps a root's entries for a card's inspect pane", () => {
    expect(laneRows(answer, { root: "envs/dev/orders", now: NOW }).map((r) => r.id)).toEqual(["b", "a"]);
    const marks = { roots: [{ member: "tg-example", name: "envs-dev-orders", path: "envs/dev/orders" }, { member: "tg-example", name: "envs-dev", path: "envs/dev" }] };
    expect(rootOfCard(marks, "tg-example/envs-dev-orders/module.service/aws_sqs_queue.jobs")).toBe("envs/dev/orders");
    expect(rootOfCard(marks, "other/x")).toBeNull();
  });

  it("says when the source has no record, rather than that nothing happened", () => {
    expect(laneLegend({ ...answer, entries: [], record: { present: false }, absent: "/r has no audit.jsonl: …" })).toBe("/r has no audit.jsonl: …");
    expect(laneLegend({ ...answer, entries: [] }, { shown: 0 })).toBe("the audit record holds no entry for github.com/acme/shop");
    expect(laneLegend(answer, { root: "envs/prod/search", shown: 0 })).toBe("the audit record names no entry for envs/prod/search");
    expect(laneLegend({ ...answer, total: 250 }, { shown: 3 })).toBe("3 of 250 entries from terragucci's audit record, newest first");
    expect(laneLegend({ error: "audit.jsonl in /r, line 2, is not JSON.", code: "terragucci-report" })).toContain("line 2");
  });
});

describe("a day-2 action's history (behold#1037)", () => {
  const GATE = "apps/orders:module.app.action.aws_lambda_invoke.rotate";
  const DIGEST = `sha256:${"a1".repeat(32)}`;
  const action = {
    id: "act",
    kind: "action",
    at: "2026-10-08T10:30:00.000Z",
    who: "dana",
    what: GATE,
    digest: DIGEST,
    result: "ok",
    roots: ["apps/orders"],
    run: { run_id: "402" },
    evidence: { source: "ledger", path: "_gates/tf-action/applied.jsonl", url: `https://github.com/acme/shop/commit/${"b".repeat(40)}` },
    detail: { root: "apps/orders", address: "module.app.action.aws_lambda_invoke.rotate", approved_by: "dana", requester: "lee" },
  };
  const asked = { ...action, id: "ask", kind: "action-requested", at: "2026-10-08T10:00:00.000Z", who: "lee", result: "waiting", run: { run_id: "401" }, evidence: { ...action.evidence, path: "_gates/tf-action.jsonl" } };

  it("renders an action entry as its name on its root, who approved it and how it ended, with its run link", () => {
    expect(entryLine(action)).toBe("rotate on apps/orders, approved by dana, ok");
    const rows = laneRows({ ...answer, entries: [action, asked] }, { root: "apps/orders", now: NOW });
    expect(rows[0].text).toBe("rotate on apps/orders, approved by dana, ok");
    expect(rows[0].tone).toBe("ok");
    expect(rows[0].links).toEqual([
      { text: "run", href: "https://github.com/acme/shop/actions/runs/402" },
      { text: "ledger commit", href: action.evidence.url },
    ]);
    expect(runUrlOf(action)).toBe("https://github.com/acme/shop/actions/runs/402");
  });

  it("renders the request as who asked, waiting, with its digest, and a failed run as failed", () => {
    expect(entryLine(asked)).toBe(`rotate on apps/orders requested by lee, waiting · plan ${"a1".repeat(6)}`);
    expect(toneOf(asked)).toBe("wave");
    expect(toneOf({ ...action, result: "failed" })).toBe("failed");
    expect(entryLine({ ...action, result: "failed" })).toBe("rotate on apps/orders, approved by dana, failed");
    // An entry with no detail still reads from its gate.
    expect(actionOf({ what: GATE, roots: [] })).toEqual({ name: "rotate", root: "apps/orders", address: "module.app.action.aws_lambda_invoke.rotate" });
    expect(runUrlOf({ ...action, evidence: { source: "ledger" } })).toBeNull();
  });
});
