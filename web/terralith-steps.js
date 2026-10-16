// `behold demo terralith`'s walkthrough: what each phase says and how a card
// reads. Pure data and functions, tested next door; web/terralith.js draws.
//
// The model comes from GET /api/terralith (src/terralith-demo.ts), which reads
// the snapshot files the demo copy's scripts write. Nothing here runs a write:
// a phase that has not run yet shows the line that runs it, to copy.

import { IDENTITY_MARKS, identityKey } from "./identity-mark.js";

/** The phases, in order. `lead` is the phase's paragraph; `facts(phase)` its counted line. */
export const PHASES = [
  {
    id: "stock",
    n: 1,
    label: "Stock",
    title: "A stock terralith",
    lead: "One Terraform root holds a network and the IAM and logging of three teams. All 23 resources sit in one state file on S3, which is where each one's identity lives.",
    facts: (p) => `${p.counts.cards} resources, ready to adopt.`,
  },
  {
    id: "adopt",
    n: 2,
    label: "Adopt",
    title: "Adopt",
    lead: "This is terragucci's backends migration. The root's backend block becomes a live block, and choudoufu live-import reads the state once and writes the tofu-estate and tofu-address tags on each resource it verifies. The state file stays in the bucket as it was.",
    facts: (p) =>
      `${p.counts.marked} of ${p.counts.cards} resources now carry the marker. ` +
      `The other ${p.counts.cards - p.counts.marked} have no tags argument, and ride the role they belong to.`,
  },
  {
    id: "split",
    n: 3,
    label: "Split",
    title: "Split",
    lead: "This is terragucci's moves migration. Three team roots appear, and in each one choudoufu live-mv rewrites the tags on that team's resources so they belong to the team's estate. Each resource takes one tag write. Inline policies and attachments follow their role with no write of their own, and split.json holds the record.",
    facts: (p) => {
      const fresh = p.boxes.filter((b) => b.spawned).length;
      return `${p.counts.moved} resources moved into ${fresh} new estate${fresh === 1 ? "" : "s"}. The terralith keeps the network.`;
    },
  },
  {
    id: "plan",
    n: 4,
    label: "Plan",
    title: "Plan across the estates",
    lead: "One pull request touches all four estates. The terralith publishes a shared setting as an output, and each team's first log group reads it through terraform_estate_outputs. It plans first. With -estate-outputs-from, each team root then plans against that planned value, so nothing waits for an apply. Last, live-summary folds the identical team changes into one group.",
    facts: (p) => {
      const groups = (p.plan && p.plan.groups) || [];
      const folded = groups.reduce((n, g) => n + g.members.length, 0);
      return `${p.counts.planned} planned changes in ${folded} estates, folded into ${groups.length} group${groups.length === 1 ? "" : "s"}. Nothing is applied.`;
    },
  },
];

export const phaseById = (id) => PHASES.find((p) => p.id === id) || null;

/** Which phase to show: the one the URL names when it has run, else the newest. */
export function shownPhase(model, wanted) {
  const ran = (model && model.phases) || [];
  if (!ran.length) return null;
  return ran.find((p) => p.id === wanted) || ran[ran.length - 1];
}

/** Each step of the stepper: ran, shown, or the one to run next. */
export function stepperItems(model, shownId) {
  const ran = new Set(((model && model.phases) || []).map((p) => p.id));
  const next = model && model.next ? model.next.id : null;
  return PHASES.map((p) => ({ id: p.id, n: p.n, label: p.label, ran: ran.has(p.id), shown: p.id === shownId, next: p.id === next }));
}

/** A card's face: the type without its provider prefix, and the resource's name. */
export function cardFace(card) {
  const [type, ...rest] = String(card.id).split(".");
  return { kind: (card.type || type).replace(/^aws_/, ""), name: rest.join(".") || card.id };
}

/** The small word in a card's corner: the phase's own news about it. */
export function cardNews(card, phaseId) {
  if (phaseId === "adopt" && card.ratified) return card.ratified;
  if (phaseId === "split" && card.moved) return card.moved.follows ? "follows its role" : `from ${card.moved.from}`;
  if (phaseId === "plan" && card.planned) return `${card.planned.actions.includes("update") ? "~" : card.planned.actions.join("/")} ${card.planned.attributes.join(", ")}`;
  return "";
}

/** A box's subtitle. */
export function boxSubtitle(box) {
  if (box.stock) return "stock root · state file on S3";
  return `estate ${box.estate}${box.spawned ? " · new" : ""}`;
}

/** The legend: one row per mark the shown phase uses, in the marks' own order. */
export function legendFor(phase) {
  const used = new Set();
  for (const b of (phase && phase.boxes) || []) for (const c of b.cards) used.add(identityKey(c.identity));
  return Object.keys(IDENTITY_MARKS)
    .filter((k) => used.has(k))
    .map((k) => ({ key: k, ...IDENTITY_MARKS[k] }));
}

/** FLIP: the translate that puts a card back where it was, from two rects. */
export function flipDelta(before, after) {
  if (!before || !after) return null;
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  return Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 ? null : { dx, dy };
}

/** Short words for a guard that planned a root in full, by choudoufu's guard kind. */
const FULL_PLAN_WORDS = {
  "empty-cone": "planned in full: the change reaches no resource",
  "estate-outputs-from": "planned in full: it reads planned outputs",
};

/** A box's plan badges: the cone, and the full plan when there was one. */
export function planBadges(box) {
  const plan = box && box.plan;
  if (!plan) return [];
  const out = [];
  if (plan.cone && !plan.cone.full) out.push({ kind: "cone", text: `cone ${plan.cone.coneBlocks} of ${plan.cone.blocks} blocks`, tip: "live-cone: the blocks this change reaches against the root's last commit." });
  const full = plan.fallback || (plan.cone && plan.cone.full ? { kind: plan.cone.kind, reason: plan.cone.reason } : null);
  if (full) out.push({ kind: "full", text: FULL_PLAN_WORDS[full.kind] || "planned in full", tip: full.reason || "" });
  return out;
}

/** The folded group's one line, as live-summary prints it. */
export function groupLabel(group) {
  const n = group.members.length;
  const change = group.changes.length === 1 ? group.changes[0].line : `${group.changes.length} changes`;
  return `${n} estates, one change: ${change}`;
}

/** A planned output's edge label. */
export function outputLabel(o) {
  return o.known ? `${o.name} = ${JSON.stringify(o.value)} · planned` : `${o.name} · known after apply`;
}

/** Are these rects one row (the desktop layout) or stacked (the phone's)? */
export function oneRow(rects) {
  if (rects.length < 2) return true;
  const top = rects[0].top;
  return rects.every((r) => Math.abs(r.top - top) < 4);
}
