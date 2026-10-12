// #525: the Releases strip. Pure words from /api/lifecycle/releases, and one
// render. One column per environment (wave order when yodel-waves.json gives
// one), one row per component or tenant. Every cell says when its release was
// recorded, by whom, and which commit of chant/lifecycle it was read from. A
// cell whose digest the environment before it does not hold is marked
// "differs from <env>" with both digests. Nothing here deploys or promotes.

import { ago, clock } from "./terragucci.js";

const short = (s) => (s ? String(s).replace(/^(jcs1-)?sha256:/, "").slice(0, 12) : "");

/** The strip's line: what was read, how, and when. */
export function releasesLegend(a, now = new Date()) {
  if (!a || a.error) return { text: `release ledger not read${a && a.error ? `: ${a.error}` : ""}`, title: "", tone: "refusal" };
  const when = `read ${ago(a.read.at, now)}`;
  if (!a.found) {
    const text = a.via === "none" ? `release ledger unknown: behold could not fetch chant/lifecycle · ${when}` : `no release recorded yet · ${when}`;
    return { text, title: a.note, tone: a.via === "none" ? "refusal" : "quiet" };
  }
  const how = a.via === "fetch" ? "fetched from origin" : "the checkout's origin/chant/lifecycle, as of its last git fetch (behold's fetch failed)";
  const order = a.order === "waves" ? "columns in yodel-waves.json's wave order" : "columns by name";
  const bad = Object.entries(a.malformed || {}).map(([env, n]) => `${env}: ${n} malformed line${n === 1 ? "" : "s"} skipped`);
  return {
    text: `release ledger on chant/lifecycle · ${when}, ${how} · ${order}`,
    title: [a.note, a.fetch && a.fetch.error ? `fetch: ${a.fetch.error}` : "", ...bad].filter(Boolean).join("\n"),
    tone: a.via === "fetch" ? "quiet" : "stale",
  };
}

/** One cell's words: digest, age, who, and a difference mark when there is one. */
export function releaseCellWords(cell, now = new Date()) {
  if (!cell) return { text: "no release", title: "", differs: null };
  const who = `${cell.actor}${cell.approver ? `, approved by ${cell.approver}` : ""}`;
  const src = cell.source && cell.source.commit ? `chant/lifecycle ${short(cell.source.commit)}${cell.source.committed ? `, committed ${clock(cell.source.committed, now)}` : ""}` : "chant/lifecycle";
  let differs = null;
  if (cell.differs) {
    const theirs = cell.differs.digest ? short(cell.differs.digest) : "nothing";
    differs = {
      text: `differs from ${cell.differs.from}`,
      title: `${cell.env} holds ${short(cell.digest)}; ${cell.differs.from} holds ${theirs}.${cell.differs.everHad ? "" : ` ${cell.differs.from}'s ledger never recorded ${short(cell.digest)}.`}`,
    };
  }
  return {
    text: `${short(cell.digest)} · ${ago(cell.timestamp, now)}`,
    title: [
      `${cell.component} in ${cell.env}`,
      `digest ${cell.digest}`,
      `recorded ${clock(cell.timestamp, now)}, ${ago(cell.timestamp, now)}, by ${who}`,
      `commit ${short(cell.gitSha)}, run ${cell.runId}`,
      `from ${src} (${cell.source ? cell.source.path : ""})`,
      differs ? differs.title : "",
    ]
      .filter(Boolean)
      .join("\n"),
    differs,
  };
}

/** The grid: header row of environments, then a row per component with a cell per environment. */
export function releaseGrid(a, now = new Date()) {
  if (!a || !a.found) return { environments: [], rows: [] };
  const at = new Map(a.cells.map((c) => [`${c.component}\u0000${c.env}`, c]));
  return {
    environments: a.environments,
    rows: a.components.map((component) => ({
      component,
      cells: a.environments.map((env) => {
        const c = at.get(`${component}\u0000${env}`);
        return { env, ...releaseCellWords(c, now), runUrl: c && c.runUrl ? c.runUrl : null, empty: !c };
      }),
    })),
  };
}

/** Render into `host`. `ui.link(text, href)` is app.js's link. */
export function renderReleases(host, a, now, ui) {
  host.replaceChildren();
  const lg = releasesLegend(a, now);
  const head = document.createElement("div");
  head.className = lg.tone === "refusal" ? "tg-refusal" : "tg-legend";
  head.textContent = lg.text;
  head.title = lg.title;
  host.appendChild(head);
  const g = releaseGrid(a, now);
  if (!g.rows.length) return;
  const table = document.createElement("table");
  table.className = "rel-strip";
  const tr = document.createElement("tr");
  tr.appendChild(document.createElement("th"));
  for (const env of g.environments) {
    const th = document.createElement("th");
    th.textContent = env;
    tr.appendChild(th);
  }
  table.appendChild(tr);
  for (const row of g.rows) {
    const r = document.createElement("tr");
    const name = document.createElement("th");
    name.className = "rel-component";
    name.textContent = row.component;
    r.appendChild(name);
    for (const c of row.cells) {
      const td = document.createElement("td");
      td.className = c.empty ? "rel-cell rel-empty" : c.differs ? "rel-cell rel-differs" : "rel-cell";
      td.title = c.title;
      const t = document.createElement("div");
      t.textContent = c.text;
      td.appendChild(t);
      if (c.differs) {
        const d = document.createElement("div");
        d.className = "rel-mark";
        d.textContent = c.differs.text;
        td.appendChild(d);
      }
      if (c.runUrl && ui && ui.link) td.appendChild(ui.link("run", c.runUrl));
      r.appendChild(td);
    }
    table.appendChild(r);
  }
  host.appendChild(table);
}
