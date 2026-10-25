// behold#999, the Pulumi half: a stock Pulumi stack member's card in the
// Adopt tab. The report is plunge stack adopt's classification without --yes:
// every resource with the ownership plunge would give it, or plunge's reasons
// for refusing the whole adoption, and nothing written. Start runs that same
// classification and shows the confirm command, which a person runs: behold
// never passes --yes (src/pulumi-adoption.ts).

const FATE_WORDS = { claimed: "claimed", unknown: "unknown ownership" };
const OWNERSHIP_ORDER = ["marker", "record", "pending"];

/** The classification's rows grouped by ownership (marker, record, pending, then any other), each group in plunge's order. */
export function pulumiGroups(report) {
  const entries = (report && Array.isArray(report.entries) && report.entries) || [];
  const seen = [...OWNERSHIP_ORDER, ...entries.map((e) => e.ownership).filter((o) => !OWNERSHIP_ORDER.includes(o))];
  const groups = [];
  for (const own of [...new Set(seen)]) {
    const rows = entries.filter((e) => e.ownership === own);
    if (rows.length) groups.push({ ownership: own, title: `${FATE_WORDS[rows[0].fate] || rows[0].fate}, by ${own} (${rows.length})`, rows });
  }
  return groups;
}

/** One line counting what is claimed, by ownership. */
export function pulumiSummary(report) {
  if (!report) return "";
  const by = Object.entries(report.byOwnership || {}).map(([k, n]) => `${n} by ${k}`);
  return `${report.claimed} of ${report.total} resource(s) claimed${by.length ? ` (${by.join(", ")})` : ""}.`;
}

/** Draw one pulumi member's card into `card`. `h` is the tab's helpers ({el, code}). */
export function renderPulumiCard(card, o, s, ui, refusal, h) {
  const { el, code } = h;
  const list = (title, items) => {
    card.appendChild(el("div", "ad-label", title));
    const ul = el("ul", "ad-list");
    for (const g of items || []) ul.appendChild(el("li", null, g));
    card.appendChild(ul);
  };
  list("What it gains", o.gains);
  list("What it does not", o.limits);
  if (!o.start || !o.start.offered) card.appendChild(el("div", "tg-legend", (o.start && o.start.why) || o.stateHint || ""));
  if (o.backend) card.appendChild(el("div", "tg-legend", `Stack ${o.stack.name} (${o.stack.from === "export" ? "from stack-export.json" : "asked"}), at ${o.backend.url}.`));

  const row = el("div", "ad-row");
  const read = el("button", null, s.reports[o.member] ? "Classify again" : "Classify");
  read.type = "button";
  read.disabled = !!refusal || !!s.reading[o.member] || !o.command;
  read.title = o.command ? `Runs ${o.command}, without --yes: plunge lists every resource and writes nothing.` : "";
  read.addEventListener("click", () => ui.read(o.member));
  row.appendChild(read);
  const start = el("button", null, "Start adoption");
  start.type = "button";
  start.disabled = !!refusal || !(o.start && o.start.offered) || !!s.starting;
  start.title = o.start && o.start.offered ? "Runs the classification; nothing is written. A person confirms it with the command shown." : (o.start && o.start.why) || "";
  start.addEventListener("click", () => ui.start(o.member));
  row.appendChild(start);
  card.appendChild(row);
  if (o.command) {
    card.appendChild(el("div", "ad-label", "What behold runs (classify only)"));
    card.appendChild(code(o.command));
  }

  const drawAnswer = (r) => {
    if (r.error) return void card.appendChild(el("div", "tg-refusal", r.remedy ? `${r.error} ${r.remedy}` : r.error));
    card.appendChild(el("div", "tg-legend", r.words || ""));
    if (r.refused && r.refused.length) {
      card.appendChild(el("div", "ad-label", `Refused (${r.refused.length})`));
      const ul = el("ul", "ad-list ad-refused");
      for (const x of r.refused) ul.appendChild(el("li", null, x.reason));
      card.appendChild(ul);
    }
    if (r.report) {
      card.appendChild(el("div", "ad-summary", pulumiSummary(r.report)));
      const t = el("table", "ad-table");
      for (const g of pulumiGroups(r.report)) {
        const th = el("tr", "ad-group");
        const cell = el("th", null, g.title);
        cell.colSpan = 4;
        th.appendChild(cell);
        t.appendChild(th);
        for (const e of g.rows) {
          const tr = el("tr", `ad-${e.fate}`);
          const addr = el("td", "ad-addr", e.name);
          addr.title = e.urn;
          tr.appendChild(addr);
          tr.appendChild(el("td", null, e.type));
          tr.appendChild(el("td", "ad-status", e.ownership));
          const why = el("td", null, e.detail ? `${e.why}. plunge: ${e.detail}` : e.why);
          tr.appendChild(why);
          t.appendChild(tr);
        }
      }
      card.appendChild(t);
    }
    if (r.confirm) {
      card.appendChild(el("div", "ad-label", "Confirm it (a person, not behold)"));
      card.appendChild(code(r.confirm));
      if (r.after) card.appendChild(el("div", "tg-legend", r.after));
    }
    if (r.backOut) {
      card.appendChild(el("div", "ad-label", "Back out"));
      card.appendChild(code(r.backOut));
    }
  };

  const r = s.reports[o.member];
  if (r) drawAnswer(r);
  const run = s.runs[o.member];
  if (run) {
    card.appendChild(el("div", "ad-label", `Started ${run.started_at || ""}`));
    if (run.outcome === "running" || run.error) card.appendChild(el("div", "tg-legend", run.words || run.error || ""));
    else drawAnswer(run);
  }
}
