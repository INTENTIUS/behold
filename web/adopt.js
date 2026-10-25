// behold#999: "adopt this root". A stock Terraform root member is offered
// adoption into choudoufu through chant workspace promote: what it gains, what
// it does not, the report of every resource with its fate (GET
// /api/adopt/report, promote's --dry-run), and the gated command. Start (POST
// /api/adopt/start) runs that command; chant's gate holds it, and nothing is
// written until a person approves the patch's digest. behold never approves
// here: the approve line is shown to copy. The tab is never drawn in a public
// view, an embed, a static export or a guarded repo (src/adoption.ts).
//
// A stock Pulumi stack member is offered adoption into plunge the same way,
// through plunge stack adopt (web/adopt-pulumi.js draws its card): the report
// is plunge's classification without --yes, Start runs that same
// classification, and the confirm command is shown for a person to run. The
// answer's refusal (the Terraform half's chant floor) never holds a pulumi card.
import { renderPulumiCard } from "./adopt-pulumi.js";

/** The tab's first line. */
export const ADOPT_LEGEND =
  "Adopt a stock member into its engine tier. A Terraform root goes to choudoufu with chant workspace promote: the report is promote's dry run (a throwaway worktree, no gate recorded, nothing written), and Start runs the gated command, which writes nothing until the patch is approved. A Pulumi stack goes to plunge with plunge stack adopt: Classify runs it without --yes, so plunge lists every resource and writes nothing, and the confirm is a command a person runs.";

const FATE_WORDS = { claimed: "claimed", "left-out": "left out", unknown: "unknown status" };

/** The report's rows grouped by fate, claimed first, each group in the order chant gave them. */
export function reportGroups(report) {
  const entries = (report && Array.isArray(report.entries) && report.entries) || [];
  const groups = [];
  for (const fate of ["claimed", "left-out", "unknown"]) {
    const rows = entries.filter((e) => e.fate === fate);
    if (rows.length) groups.push({ fate, title: `${FATE_WORDS[fate]} (${rows.length})`, rows });
  }
  return groups;
}

/** One line counting what is claimed and what is left out, by status. */
export function reportSummary(report) {
  if (!report) return "";
  const left = Object.entries(report.leftOut || {}).map(([k, n]) => `${n} ${k}`);
  return `${report.claimed} of ${report.total} resource instance(s) claimed${left.length ? `; left out: ${left.join(", ")}` : ""}.`;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const code = (text) => {
  const c = el("code", "ad-cmd", text);
  c.title = "click to copy";
  c.tabIndex = 0;
  c.addEventListener("click", () => navigator.clipboard?.writeText(text).catch(() => {}));
  return c;
};

/**
 * Draw the tab. `s.answer` is GET /api/adopt; `s.reports[member]` a report
 * answer; `s.runs[member]` the newest adoption started for it.
 */
export function renderAdopt(host, s, ui) {
  host.replaceChildren();
  host.appendChild(el("div", "tg-legend", ADOPT_LEGEND));
  const a = s.answer;
  if (!a) return void host.appendChild(el("div", "tg-legend", "reading what each member is offered"));
  if (a.error) return void host.appendChild(el("div", "tg-refusal", a.error));
  if (a.refusal) {
    const r = el("div", "tg-refusal", a.refusal.error);
    if (a.refusal.remedy) r.title = a.refusal.remedy;
    host.appendChild(r);
  }
  if (a.recorded) host.appendChild(el("div", "tg-legend ad-recorded", a.recorded));
  const offers = a.offers || [];
  if (!offers.length) host.appendChild(el("div", "tg-legend", "No member here is offered adoption: behold offers it for a terraform or a pulumi member."));
  for (const o of offers) {
    const card = el("div", "ad-card");
    card.appendChild(el("h3", null, `${o.member} · ${o.kind}${o.engine ? ` to ${o.engine}` : ""} · ${o.dir}`));
    if (!o.offered) {
      card.appendChild(el("div", "tg-legend", o.waits || "not offered"));
      host.appendChild(card);
      continue;
    }
    if (o.kind === "pulumi") {
      renderPulumiCard(card, o, s, ui, null, { el, code });
      host.appendChild(card);
      continue;
    }
    const gains = el("ul", "ad-list");
    for (const g of o.gains || []) gains.appendChild(el("li", null, g));
    card.appendChild(el("div", "ad-label", "What it gains"));
    card.appendChild(gains);
    const limits = el("ul", "ad-list");
    for (const g of o.limits || []) limits.appendChild(el("li", null, g));
    card.appendChild(el("div", "ad-label", "What it does not"));
    card.appendChild(limits);
    if (!o.recorded && o.state && !o.state.present) card.appendChild(el("div", "tg-legend", o.stateHint || ""));

    const row = el("div", "ad-row");
    const read = el("button", null, s.reports[o.member] ? "Read the report again" : "Read the report");
    read.type = "button";
    read.disabled = !!a.refusal || !!s.reading[o.member] || (!o.recorded && o.state && !o.state.present);
    read.addEventListener("click", () => ui.read(o.member));
    row.appendChild(read);
    const start = el("button", null, "Start adoption");
    start.type = "button";
    start.disabled = !!a.refusal || !(o.start && o.start.offered) || !!s.starting;
    start.title = o.start && o.start.offered ? `Runs ${o.command}. chant records a pending gate; nothing is written before approval.` : (o.start && o.start.why) || "";
    start.addEventListener("click", () => ui.start(o.member));
    row.appendChild(start);
    card.appendChild(row);
    card.appendChild(el("div", "ad-label", "The command"));
    card.appendChild(code(o.command));

    const r = s.reports[o.member];
    if (r) {
      if (r.error) card.appendChild(el("div", "tg-refusal", r.remedy ? `${r.error} ${r.remedy}` : r.error));
      else {
        if (r.recorded) card.appendChild(el("div", "tg-legend ad-recorded", "recorded"));
        card.appendChild(el("div", "tg-legend", r.words));
        if (r.failed && r.failed.output) card.appendChild(el("pre", "ad-out", r.failed.output));
        if (r.report) {
          card.appendChild(el("div", "ad-summary", reportSummary(r.report)));
          const t = el("table", "ad-table");
          for (const g of reportGroups(r.report)) {
            const th = el("tr", "ad-group");
            const cell = el("th", null, g.title);
            cell.colSpan = 4;
            th.appendChild(cell);
            t.appendChild(th);
            for (const e of g.rows) {
              const tr = el("tr", `ad-${e.fate}`);
              tr.appendChild(el("td", "ad-addr", e.address));
              tr.appendChild(el("td", null, e.type));
              tr.appendChild(el("td", "ad-status", e.status));
              const why = el("td", null, e.why);
              why.title = e.detail || "";
              tr.appendChild(why);
              t.appendChild(tr);
            }
          }
          card.appendChild(t);
        } else if (r.absent) card.appendChild(el("div", "tg-legend", r.absent));
      }
    }
    const run = s.runs[o.member];
    if (run) {
      card.appendChild(el("div", "ad-label", `Started ${run.started_at || ""}`));
      card.appendChild(el("div", "tg-legend", run.words || run.error || ""));
      if (run.approve) {
        card.appendChild(el("div", "ad-label", "Approve it (a person, not behold)"));
        card.appendChild(code(run.approve));
      }
    }
    host.appendChild(card);
  }
}

/** Mount the tab. `fetchJson(url, init)` answers parsed JSON. */
export function startAdopt(host, { fetchJson, events, toast = () => {} }) {
  const s = { answer: null, reports: {}, reading: {}, runs: {}, starting: false };
  const ids = {};
  const redraw = () => renderAdopt(host, s, ui);
  const readOffer = async () => {
    s.answer = await fetchJson("/api/adopt").catch((e) => ({ error: String(e) }));
    redraw();
  };
  const readRun = async (member) => {
    const id = ids[member];
    if (!id) return;
    s.runs[member] = await fetchJson(`/api/adopt/runs/${encodeURIComponent(id)}`).catch((e) => ({ error: String(e) }));
    redraw();
  };
  const ui = {
    read: async (member) => {
      s.reading[member] = true;
      redraw();
      s.reports[member] = await fetchJson(`/api/adopt/report?member=${encodeURIComponent(member)}`).catch((e) => ({ error: String(e) }));
      s.reading[member] = false;
      redraw();
    },
    start: async (member) => {
      s.starting = true;
      redraw();
      const r = await fetchJson("/api/adopt/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ member }) }).catch((e) => ({ error: String(e) }));
      s.starting = false;
      if (r.error) {
        toast(`✗ adopt ${member}: ${r.error}`, false);
        s.runs[member] = { error: r.remedy ? `${r.error} ${r.remedy}` : r.error };
        redraw();
        return;
      }
      toast(`▶ ${r.command}`, true);
      ids[member] = r.id;
      await readRun(member);
    },
  };
  if (events) {
    events.addEventListener("adopt-run", (e) => {
      for (const [member, id] of Object.entries(ids)) if (id === e.data) readRun(member);
    });
  }
  readOffer();
  return { reload: readOffer };
}
