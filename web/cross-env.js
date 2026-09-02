// #234's last remainder — the cross-environment half of "is prod running what
// staging tested", the pure half (tested the way web/release.js and
// web/run-playhead.js are — no DOM). The payload is /api/components/compare's
// `{env, to, comparisons}`, each comparison chant's own CrossEnvComparison:
// `same` decided on the COMPARABLE identity (inputDigest ?? digest per side —
// a pinned helm deploy's bytes legitimately differ per cluster), `comparedOn`
// present when the input side spoke, digests always visible.

/** Tone vocabulary matches the component palette: good / warn / neutral. */
export function comparisonRow(c) {
  const missingA = !c.digestA;
  const missingB = !c.digestB;
  if (missingA && missingB) {
    return { component: c.component, tone: "neutral", verdict: "unrecorded", detail: `no release recorded in ${c.envA} or ${c.envB}` };
  }
  if (missingA || missingB) {
    const where = missingA ? c.envA : c.envB;
    return { component: c.component, tone: "neutral", verdict: "unrecorded", detail: `no release recorded in ${where}` };
  }
  if (c.same) {
    // The honest wording: matching inputs with differing bytes is still
    // "same" — that is chant#1243's contract, and saying "same bytes" here
    // would claim more than the ledger does.
    const inputDecided = !!c.comparedOn && c.comparedOn.a === c.comparedOn.b && c.digestA !== c.digestB;
    return {
      component: c.component,
      tone: "good",
      verdict: inputDecided ? "same inputs" : "same",
      detail: inputDecided
        ? `built from the same inputs (${short(c.comparedOn.a)}); rendered bytes differ per cluster, as pinned deploys do`
        : `same digest in both (${short(c.digestA)})`,
    };
  }
  return {
    component: c.component,
    tone: "warn",
    verdict: "differs",
    detail: `${c.envA}: ${short(c.digestA)} · ${c.envB}: ${short(c.digestB)}`,
  };
}

/** One line for the section header: the counts, worst-tone-first. */
export function comparisonSummary(payload) {
  const rows = (payload.comparisons || []).map(comparisonRow);
  if (!rows.length) return { text: `no components recorded in ${payload.env} or ${payload.to}`, tone: "neutral" };
  const differs = rows.filter((r) => r.tone === "warn").length;
  const unrecorded = rows.filter((r) => r.tone === "neutral").length;
  const same = rows.length - differs - unrecorded;
  if (differs) return { text: `${differs} of ${rows.length} differ from ${payload.to}`, tone: "warn" };
  if (same === rows.length) return { text: `all ${rows.length} running what ${payload.to} tested`, tone: "good" };
  return { text: `${same} same as ${payload.to}, ${unrecorded} unrecorded`, tone: "neutral" };
}

function short(digest) {
  if (!digest) return "—";
  const hex = digest.startsWith("sha256:") ? digest.slice(7) : digest;
  return hex.slice(0, 12);
}
