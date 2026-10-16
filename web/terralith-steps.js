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
