// What the last read cost, as one line (#421, M2 of #419).
//
// The person staring at the loading scrim has exactly one question — is this
// three seconds or three minutes — and behold has never answered it. #420's
// ledger knows; this turns it into a sentence.
//
// The number reported is the SLOWEST recent member read, not the sum. An estate
// read fans out under a shared budget (src/estate.ts) and finishes when its last
// member does, so the slowest member is what the wall clock actually follows.
// Summing would report a number no one ever waits for.

/** Whole-second durations, because nobody waiting cares about milliseconds. */
export function humanMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 1) return "under a second";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}m ${rest}s` : `${m}m`;
}

/**
 * One line for the scrim, or null when there is nothing honest to say.
 *
 * Null rather than a zero or a guess: this is the same rule the rest of behold
 * holds to about absent figures. A fresh server with no reads behind it says
 * nothing, and preview mode — which gets the totals and not the samples — says
 * nothing too, because "slowest member" is a claim about members.
 */
export function readCostLine(reads) {
  const recent = reads && Array.isArray(reads.recent) ? reads.recent : null;
  if (!recent || recent.length === 0) return null;
  const slowest = recent.reduce((worst, r) => (r && r.runningMs > worst.runningMs ? r : worst), recent[0]);
  const took = humanMs(slowest.runningMs);
  if (!took) return null;
  const members = new Set(recent.map((r) => r.dir)).size;
  const who = [slowest.dir, slowest.what].filter(Boolean).join(" ");
  const scope = members === 1 ? "1 member" : `${members} members`;
  return `last read: ${scope}, slowest ${took}${who ? ` (${who})` : ""}`;
}
