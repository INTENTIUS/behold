// #505: the chant/lifecycle lane of a terragucci repo, in words. Pure: app.js
// fetches /api/terragucci/lifecycle (and hears /api/terragucci/events), then
// renders what these functions return.
//
// Every gate and lock says which commit of chant/lifecycle it came from and
// how old that commit is, and the lane's line says when behold last read the
// branch and how (fetched from origin, or the checkout's own copy when the
// fetch failed). Nothing here is painted as live, and nothing approves,
// locks or unlocks: a waiting wave offers the line a person runs.

import { ago, clock } from "./terragucci.js";

const short = (s) => (s ? String(s).replace(/^(jcs1-)?sha256:/, "").slice(0, 12) : "");

/** Where an entry came from: "chant/lifecycle 1a2b3c4d5e6f, committed 09:00 UTC, 2h ago". */
export function sourceWords(source, now = new Date()) {
  return `chant/lifecycle ${short(source.commit)}, committed ${clock(source.committed, now)}, ${ago(source.committed, now)}`;
}

/** The lane's line under the tab title: what was read, how, and when. `title` carries the note. */
export function laneLegend(lane, now = new Date(), polled = null) {
  if (!lane || lane.error) return { text: `chant/lifecycle not read${lane && lane.error ? `: ${lane.error}` : ""}`, title: "", tone: "refusal" };
  const looked = polled && polled.at && polled.at > lane.read.at ? polled.at : lane.read.at;
  const when = `read ${ago(looked, now)}`;
  if (!lane.found) {
    const text = lane.via === "none" ? `chant/lifecycle unknown: behold could not fetch it · ${when}` : `no chant/lifecycle branch yet: no gate asked, no root locked · ${when}`;
    return { text, title: lane.note, tone: lane.via === "none" ? "refusal" : "quiet" };
  }
  const how = lane.via === "fetch" ? "fetched from origin" : "the checkout's origin/chant/lifecycle, as of its last git fetch (behold's fetch failed)";
  return {
    text: `chant/lifecycle at ${short(lane.commit.sha)}, committed ${ago(lane.commit.committed, now)} · ${when}, ${how}`,
    title: [lane.note, lane.fetch && lane.fetch.error ? `fetch: ${lane.fetch.error}` : ""].filter(Boolean).join("\n"),
    tone: lane.via === "fetch" ? "quiet" : "stale",
  };
}

const TITLE = {
  waiting: (g) => `wave ${g.wave} waits for an approval`,
  expired: (g) => `wave ${g.wave}'s request for an approval expired`,
  approved: (g) => `wave ${g.wave} approved by ${g.approval.by}, not applied yet`,
  applied: (g) => `wave ${g.wave} applied`,
  failed: (g) => `wave ${g.wave}'s apply failed`,
};

/** Each wave's gate as a card: its state, who and when, the digest, the commit it was read from, and for a waiting wave the line to run. No button. */
export function laneGateCards(lane, now = new Date()) {
  if (!lane || !lane.found) return [];
  return lane.gates.map((g) => {
    const facts = [];
    if (g.pending) facts.push(`asked ${clock(g.pending.timestamp, now)}, ${ago(g.pending.timestamp, now)}`);
    if (g.approval) facts.push(`approved by ${g.approval.by}${g.approval.signed ? " (signed)" : ""}${g.approval.via ? ` via ${g.approval.via}` : ""} ${clock(g.approval.at, now)}, ${ago(g.approval.at, now)}`);
    if (g.applied) facts.push(`${g.applied.result === "failed" ? "apply failed" : "applied"} ${clock(g.applied.finished || g.applied.at, now)}, ${ago(g.applied.finished || g.applied.at, now)}`);
    if (g.digest) facts.push(`plan ${short(g.digest)}`);
    return {
      wave: g.wave,
      state: g.state,
      tone: g.state === "waiting" ? "wave" : g.state === "failed" ? "failed" : g.state === "expired" ? "none" : "ok",
      title: TITLE[g.state] ? TITLE[g.state](g) : `wave ${g.wave}: ${g.state}`,
      facts: facts.join(" · "),
      source: sourceWords(g.source, now),
      ...(g.command ? { command: g.command, note: "An approval is a signed git record bound to this plan digest: run the line at your shell. behold does not approve." } : {}),
      ...(g.pending && g.pending.url ? { job: g.pending.url } : {}),
    };
  });
}

/** Each locked root: who holds it and since when, and the commit it was read from. */
export function laneLockRows(lane, now = new Date()) {
  if (!lane || !lane.found) return [];
  return lane.locks.map((l) => {
    const how = l.stage === "plan" ? "its plan" : l.via === "lock" ? "/terragucci lock" : "an apply";
    return {
      root: l.root,
      text: `locked by PR #${l.pr} (${l.by}, by ${how}) ${clock(l.at, now)}, ${ago(l.at, now)}`,
      title: `head ${short(l.head)}\nfrom ${sourceWords(l.source, now)}\nUnlocking is a pull request comment (/terragucci unlock), never behold's.`,
    };
  });
}

/**
 * The lane in the Terragucci tab: the line, a card per gate, a row per lock.
 * `ui` lends app.js's own `button`, `copy` and `link`, so the cards look like
 * the reports' wave cards. A Copy button is the only control: no approve,
 * lock or unlock.
 */
export function renderLane(host, lane, polled, now, ui) {
  const lg = laneLegend(lane, now, polled);
  const head = document.createElement("div");
  head.className = lg.tone === "refusal" ? "tg-refusal" : "tg-legend";
  head.textContent = lg.text;
  head.title = lg.title;
  host.appendChild(head);
  if (polled && polled.reports && polled.reports.error) {
    const e = document.createElement("div");
    e.className = "tg-legend";
    e.textContent = `the reports' index could not be checked: ${polled.reports.error}`;
    host.appendChild(e);
  }
  for (const g of laneGateCards(lane, now)) {
    const box = document.createElement("div");
    box.className = `ws-gate tg-lane-gate tg-${g.tone}`;
    const title = document.createElement("div");
    title.className = "ws-gate-title";
    title.textContent = g.title;
    const facts = document.createElement("div");
    facts.className = "ws-gate-facts";
    facts.textContent = g.facts;
    const src = document.createElement("div");
    src.className = "ws-gate-note";
    src.textContent = `from ${g.source}`;
    box.append(title, facts, src);
    if (g.command) {
      const cmd = document.createElement("code");
      cmd.className = "tg-command";
      cmd.textContent = g.command;
      const copy = ui.button("Copy", "", () => ui.copy(g.command, copy));
      copy.title = "Copy the line. Run it at your shell: the approval is yours, signed, in git.";
      const note = document.createElement("div");
      note.className = "ws-gate-note";
      note.textContent = g.note;
      box.append(cmd, copy, note);
    }
    if (g.job) {
      const links = document.createElement("div");
      links.className = "ws-gate-note";
      links.appendChild(ui.link("job", g.job));
      box.appendChild(links);
    }
    host.appendChild(box);
  }
  for (const l of laneLockRows(lane, now)) {
    const row = document.createElement("div");
    row.className = "tg-root tg-lock";
    const path = document.createElement("div");
    path.className = "tg-path";
    path.textContent = l.root;
    const what = document.createElement("div");
    what.textContent = l.text;
    what.title = l.title;
    row.append(path, what);
    host.appendChild(row);
  }
}
