// #165 (#61's second clause): the recorded release, read off a component
// node's `_release` attr (src/component-status.ts's `releaseStatus`). The pure
// half, tested the way web/operator.js and web/run-playhead.js are — no DOM.
// The card chip (`release`) already answers "which commit, through what"; this
// is the pane's fuller answer — which run, from which commit, approved by whom
// — and, when the record cannot be followed, the reason in words.
import { approvalLink } from "./operator.js";
import { waitingFor } from "./run-playhead.js";

/** How the pane names each id space. `laptop` for a local mint: "local" would
 * read as a place, and the point is that there is nowhere to go. */
export const FORGE_LABEL = { github: "GitHub Actions", gitlab: "GitLab CI", op: "an Op run", local: "a laptop run", unknown: "an unlinked run" };

/** The one line that says why there is no link, or null when there is one.
 * Never a placeholder link, never a guessed forge: the three id spaces a
 * `runId` can live in are mutually incompatible, so a link behold built from
 * a bare id would as often be wrong as right (chant#2045). */
export function unlinkedReason(release) {
  if (!release) return null;
  if (runLink(release)) return null;
  switch (release.forge) {
    case "local":
      return release.originSource === "record"
        ? "minted on the machine that deployed — the record says so; there is no run to open"
        : "minted on the machine that deployed (a local- id) — there is no run to open";
    case "unknown":
      return "the record names a run id and nothing else — no forge, no repo, no URL. A chant older than chant#2045 wrote it; behold will not guess which forge the id belongs to";
    case "op":
      return "an orchestrator run id — the run lives in Temporal, not on a forge";
    default:
      return `${FORGE_LABEL[release.forge] || release.forge} named no server URL when this was recorded, so the id cannot be resolved to a link`;
  }
}

/** The run's absolute http(s) URL, or null. Same validator as the gate card's
 * `approve at:` — an address the ledger itself carries, or nothing. */
export function runLink(release) {
  return release && release.originSource === "record" ? approvalLink(release.url) : null;
}

/** `<runId> (<forge>)` — the run row's text, link or no link. */
export function runText(release) {
  const forge = FORGE_LABEL[release.forge] || release.forge;
  return release.repo ? `${release.runId} · ${forge} · ${release.repo}` : `${release.runId} · ${forge}`;
}

/** The pane's rows, in order: `[key, value]` pairs plus an optional caveat
 * row keyed `""`. The link is returned as `{href, text}` so the DOM half makes
 * the anchor and this half stays testable. */
export function releaseRows(release, now = Date.now()) {
  if (!release) return [];
  const rows = [];
  const href = runLink(release);
  rows.push(["run", href ? { href, text: runText(release) } : runText(release)]);
  const why = unlinkedReason(release);
  if (why) rows.push(["", why]);
  rows.push(["commit", release.gitSha]);
  rows.push(["digest", release.digest]);
  const ago = release.timestamp ? waitingFor(release.timestamp, now) : null;
  rows.push(["recorded", ago ? `${release.timestamp} (${ago} ago)` : release.timestamp]);
  rows.push(["actor", release.actor]);
  // Absent means ungated — chant omits `approver` exactly then — so the row
  // says that rather than leaving a gap the reader could take for a redaction.
  rows.push(["approver", release.approver || "none — an ungated change"]);
  return rows;
}
