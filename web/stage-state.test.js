import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { leftWords, renderStages, stageCard, stagesLegend, stagesView } from "./stage-state.js";
import { stagesFromStatus } from "../src/stage-state.ts";

// #1236: the words the Stages tab draws, for the answer /api/workspace/stages
// gives on src/__fixtures__/stage-state/status-prod.json (see
// src/stage-state.test.ts for the scene).
const NOW = new Date("2026-11-20T12:00:00Z");
const doc = JSON.parse(readFileSync(join(import.meta.dirname, "..", "src", "__fixtures__", "stage-state", "status-prod.json"), "utf8"));
const read = stagesFromStatus(doc, { readAt: "2026-11-20T12:00:00.000Z" });
if (!read.ok) throw new Error(read.refusal.error);
const answer = { workspace: true, chant: "0.124.110", ...read.state };
const stage = (member, name) => answer.members.find((m) => m.member === member).stages.find((s) => s.name === name);
const rows = (member, name) => Object.fromEntries(stageCard(stage(member, name)).rows.map((r) => [r.key, r]));

describe("leftWords", () => {
  it("says the time left in hours and minutes", () => {
    expect(leftWords(3_600_000)).toBe("1h");
    expect(leftWords(4_500_000)).toBe("1h 15m");
    expect(leftWords(720_000)).toBe("12m");
    expect(leftWords(40_000)).toBe("40s");
    expect(leftWords(null)).toBeNull();
  });
});

describe("stagesLegend", () => {
  it("names the read, or the refusal", () => {
    expect(stagesLegend(answer, NOW).text).toBe("3 pipelines · status read at prod · read 12:00 UTC");
    expect(stagesLegend({ workspace: true, refusal: { error: "Stage state needs chant 0.124.110 or newer.", remedy: "Upgrade." } }, NOW)).toMatchObject({ tone: "refusal", text: "stages not read: Stage state needs chant 0.124.110 or newer." });
  });
});

describe("stageCard (#1236)", () => {
  it("draws the held canary and the requested rollback in prod", () => {
    const card = stageCard(stage("shop", "prod"));
    expect(card.head).toBe("prod · after canary · on verify fail: rollback");
    const r = rows("shop", "prod");
    expect(r.release.text).toBe("runs v1.1.0 · api");
    expect(r.gate).toMatchObject({ text: "gate prod: approved 1/1 for v1.1.0", tone: "ok" });
    expect(r.gate.command).toBeUndefined();
    expect(r["canary:canary"]).toMatchObject({ text: "held by canary canary: soaking, 1h left", tone: "wait" });
    expect(r.queue.text).toBe("queue: waiting v1.2.0");
    expect(r.rollback).toMatchObject({ text: "rollback to v1.0.0 requested by ci after verify failed on v1.1.0 · gate prod-rollback: pending", tone: "fail" });
    expect(r.rollback.commands).toEqual([stage("shop", "prod").rollback.approve, "chant components rollback prod --requested"]);
  });

  it("draws the canary's soak with its time left, and the risk over its threshold with chant's reason", () => {
    const r = rows("shop", "canary");
    expect(r.soak).toMatchObject({ text: "soak 2h · soaking · 1h left · due 2026-11-20T13:00:00.000Z · holds the promote into prod", tone: "wait" });
    expect(r.risk).toMatchObject({ text: "risk 0.40 medium for v1.1.0 · over 0.3: the gate takes more approvals", tone: "wait", reasons: ["the score 0.4 is above 0.3"] });
    expect(stageCard(stage("shop", "canary")).head).toBe("canary · canary · after dev · on verify fail: hold");
  });

  it("draws a pause with the release waiting behind it", () => {
    expect(rows("shop", "dev").paused).toMatchObject({ text: "paused by carol: db upgrade · waiting v1.1.0", tone: "wait" });
  });

  it("gives a waiting gate chant's approve line to copy", () => {
    const r = rows("network", "prod");
    expect(r.gate).toMatchObject({ text: "gate prod: pending 0/1 for v1.1.0", tone: "wait" });
    expect(r.gate.command).toBe(stage("network", "prod").gate.approve);
    expect(r.risk.reasons).toEqual(["the score 0.55 is above 0.3"]);
  });

  it("draws a hold and a held rollback on the sql member", () => {
    const r = rows("orders-db", "prod");
    expect(r.held).toMatchObject({ text: "held until a change to the pipeline lifts it: schema review", reasons: ["before it goes on: Read the orders migration plan before lifting the hold."] });
    expect(r.rollbackHeld).toMatchObject({ text: "rollback held after verify failed on v1.1.0: stage prod ran no earlier release of orders-db", tone: "fail" });
  });

  it("draws a soak state it has no word for in the neutral tone, as chant wrote it", () => {
    const s = structuredClone(stage("shop", "canary"));
    s.soak.state = "resting";
    expect(stageCard(s).rows.find((r) => r.key === "soak")).toMatchObject({ tone: "quiet", text: expect.stringContaining("resting") });
  });
});

describe("stagesView", () => {
  it("heads each member with its kind and pipeline", () => {
    expect(stagesView(answer, NOW).members.map((m) => m.head)).toEqual(["network (terraform) · pipeline net", "shop (pulumi) · pipeline shop", "orders-db (sql) · pipeline db"]);
  });
  it("notes members with no pipeline", () => {
    const v = stagesView({ ...answer, others: [{ member: "web", kind: "chant" }] }, NOW);
    expect(v.notes).toEqual(["web: chant lists stages for a member with a .chant/pipeline.ts that folds"]);
  });
});

describe("renderStages", () => {
  it("draws one card per stage, with the copy lines under their rows", () => {
    const make = (tag) => {
      const el = { tag, children: [], dataset: {}, className: "", textContent: "", title: "", listeners: {} };
      el.appendChild = (c) => (el.children.push(c), c);
      el.append = (...cs) => cs.forEach((c) => el.children.push(c));
      el.replaceChildren = () => (el.children = []);
      el.addEventListener = (k, f) => (el.listeners[k] = f);
      return el;
    };
    const saved = globalThis.document;
    globalThis.document = { createElement: make, createTextNode: (t) => ({ tag: "#text", textContent: t, children: [] }) };
    try {
      const host = make("div");
      const copied = [];
      renderStages(host, answer, NOW, { copy: (l) => copied.push(l) });
      expect(host.children.filter((c) => c.tag === "h3").map((c) => c.textContent)).toHaveLength(3);
      const cards = host.children.filter((c) => c.className === "stage-card");
      expect(cards.map((c) => `${c.dataset.member}/${c.dataset.stage}`)).toEqual(["network/dev", "network/prod", "shop/dev", "shop/canary", "shop/prod", "orders-db/dev", "orders-db/prod"]);
      const prod = cards[4];
      const lines = prod.children.filter((c) => c.className === "stage-command");
      expect(lines.map((c) => c.textContent)).toEqual([stage("shop", "prod").rollback.approve, "chant components rollback prod --requested"]);
      lines[1].listeners.click();
      expect(copied).toEqual(["chant components rollback prod --requested"]);
    } finally {
      globalThis.document = saved;
    }
  });
});
