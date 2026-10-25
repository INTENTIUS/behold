// behold#999: "adopt this root or stack". A stock member is offered adoption
// into its engine tier: what it gains, what it does not, every resource with
// its fate, and the command. On this branch the member kind offered is
// pulumi, into plunge (web/adopt-pulumi.js draws its card): the report is
// plunge stack adopt's classification without --yes, Start runs that same
// classification, and the confirm command is shown for a person to run. behold
// never confirms here. The tab is never drawn in a public view, an embed, a
// static export or a guarded repo (src/adoption.ts).
import { renderPulumiCard } from "./adopt-pulumi.js";

/** The tab's first line. */
export const ADOPT_LEGEND =
  "Adopt a stock member into its engine tier. A Pulumi stack is adopted into plunge with plunge stack adopt: Classify runs it without --yes, so plunge lists every resource and writes nothing, and the confirm is a command a person runs.";

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
  if (!offers.length) host.appendChild(el("div", "tg-legend", "No member here is offered adoption: behold offers it for a pulumi member."));
  for (const o of offers) {
    const card = el("div", "ad-card");
    card.appendChild(el("h3", null, `${o.member} · ${o.kind}${o.engine ? ` to ${o.engine}` : ""} · ${o.dir}`));
    if (!o.offered) {
      card.appendChild(el("div", "tg-legend", o.waits || "not offered"));
      host.appendChild(card);
      continue;
    }
    if (o.kind === "pulumi") renderPulumiCard(card, o, s, ui, a.refusal, { el, code });
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
