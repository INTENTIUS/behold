// behold#685: "Run this job locally". behold starts `chant ci run plan
// --local --events-json` at a commit (POST /api/chant/ci/local), and draws the
// run from its run-event/v1 lines in the runs pane's run view
// (web/kiosk-runs.js renderRun), next to CI's run of the same job at the same
// commit from chant's run index when serve has --ci-report-url. Plan only:
// apply is never offered here (src/ci-local-run.ts APPLY_REFUSAL). The tab is
// never drawn in a public view, an embed, a static export or a guarded repo.

import { renderRun, STATUS_WORDS } from "./kiosk-runs.js";

/** The tab's first line. */
export const LOCAL_LEGEND =
  "Runs a CI job on this machine with chant ci run --local: a fresh worktree of the commit, no push, no commit status, nothing under the report URL. chant keeps the run's record on the local chant/lifecycle.";

const sha8 = (s) => (s ? String(s).slice(0, 8) : "");

/** What the tab offers, from GET /api/chant/ci/local's `offer`. */
export function offerView(answer) {
  const offer = (answer && answer.offer) || null;
  if (!offer) return { can: false, refusal: answer && answer.error ? answer.error : "behold did not say what it offers here", remedy: "", apply: null, env: "", members: [], ciIndex: false };
  return {
    can: (offer.jobs || []).includes("plan"),
    refusal: offer.refusal ? offer.refusal.error : null,
    remedy: offer.refusal && offer.refusal.remedy ? offer.refusal.remedy : "",
    apply: offer.apply || null,
    env: offer.env || "",
    members: offer.members || [],
    ciIndex: !!offer.ciIndex,
  };
}

/** CI's plan jobs from chant's run index (GET /api/chant/ci/runs), each a job a local run can repeat. */
export function ciPlanRows(index) {
  const runs = index && index.doc && Array.isArray(index.doc.runs) ? index.doc.runs : [];
  return runs
    .filter((r) => r.job === "plan" && r.pull !== null && r.pull !== undefined)
    .map((r) => ({
      id: r.id,
      commit: r.commit,
      pr: r.pull,
      member: r.member || null,
      text: `plan of #${r.pull} at ${sha8(r.commit)}${r.member ? ` · ${r.member}` : ""} · ${STATUS_WORDS[r.status] || r.status}`,
    }));
}

/** The body POST /api/chant/ci/local takes, from the form's values; null with the reason when one is missing. */
export function askBody({ commit, pr, env, base, member, forge }) {
  const c = String(commit || "").trim();
  const p = String(pr || "").trim();
  if (!/^[0-9a-f]{7,64}$/.test(c)) return { error: "a commit's sha, 7 hex digits or more" };
  if (!/^[1-9][0-9]*$/.test(p)) return { error: "the pull request's number: chant's plan job reads it" };
  const body = { job: "plan", commit: c, pr: Number(p) };
  if (String(env || "").trim()) body.env = String(env).trim();
  if (String(base || "").trim()) body.base = String(base).trim();
  if (member) body.member = member;
  if (forge) body.forge = forge;
  return { body };
}

/** The two halves' headings: where each run ran. */
export function compareHeads(answer) {
  const doc = answer && answer.doc;
  const local = doc ? `This machine · chant ci run plan --local · base ${sha8(doc.base)} · ${doc.env}${doc.where && doc.where.forge && doc.where.forge !== "local" ? ` · chant said it ran on ${doc.where.forge}` : ""}` : "This machine";
  return { local, ci: "CI · from chant's run index" };
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * Draw the tab into `host`. `s` holds `offer` (GET /api/chant/ci/local),
 * `index` (GET /api/chant/ci/runs, or null), `answer` (GET
 * /api/chant/ci/local/:id) and the form's values; `ui.start(body)` posts,
 * `ui.pick(id)` opens a run, `ui.redraw()` draws again.
 */
export function renderLocalRuns(host, s, ui) {
  host.replaceChildren();
  const v = offerView(s.offer);
  host.appendChild(el("div", "tg-legend", LOCAL_LEGEND));
  if (v.refusal) {
    const r = el("div", "tg-refusal", v.refusal);
    if (v.remedy) r.title = v.remedy;
    host.appendChild(r);
  }
  if (v.apply) host.appendChild(el("div", "tg-legend", v.apply));

  // The form: a commit and its pull request, and what CI ran it with.
  const form = el("div", "lr-form");
  const field = (name, label, value, placeholder) => {
    const l = el("label", "lr-field", label);
    const i = el("input");
    i.name = name;
    i.value = value || "";
    if (placeholder) i.placeholder = placeholder;
    i.spellcheck = false;
    i.addEventListener("input", () => (s.form[name] = i.value));
    l.appendChild(i);
    form.appendChild(l);
  };
  s.form = s.form || {};
  if (s.form.env === undefined) s.form.env = v.env;
  field("commit", "commit", s.form.commit, "sha");
  field("pr", "pull request", s.form.pr, "#");
  field("env", "env", s.form.env, "the pipeline's env");
  field("base", "base", s.form.base, "where it leaves the trunk");
  const pick = (name, label, options) => {
    const l = el("label", "lr-field", label);
    const sel = el("select");
    sel.name = name;
    for (const [value, text] of options) {
      const o = el("option", null, text);
      o.value = value;
      if ((s.form[name] || "") === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => (s.form[name] = sel.value));
    l.appendChild(sel);
    form.appendChild(l);
  };
  pick("member", "member", [["", "the workspace"], ...v.members.map((m) => [m, m])]);
  pick("forge", "forge", [["", "detect"], ["github", "github"], ["gitlab", "gitlab"], ["forgejo", "forgejo"]]);
  const go = el("button", "lr-go", "Run plan locally");
  go.type = "button";
  go.disabled = !v.can || !!s.starting;
  go.title = v.can ? "Start chant ci run plan --local at this commit." : v.refusal || "";
  go.addEventListener("click", () => {
    const a = askBody(s.form);
    if (a.error) {
      s.formError = a.error;
      ui.redraw();
      return;
    }
    ui.start(a.body);
  });
  form.appendChild(go);
  host.appendChild(form);
  if (s.formError) host.appendChild(el("div", "tg-refusal", s.formError));

  // CI's plan jobs, each one click from running here.
  if (v.ciIndex) {
    host.appendChild(el("h3", null, "CI's plan jobs"));
    const rows = ciPlanRows(s.index);
    if (!s.index) host.appendChild(el("div", "tg-legend", "reading chant's run index"));
    else if (s.index.error || s.index.absent) host.appendChild(el("div", "tg-legend", s.index.error || s.index.absent));
    else if (!rows.length) host.appendChild(el("div", "tg-legend", "chant's run index lists no plan job of a pull request"));
    for (const r of rows) {
      const row = el("div", "lr-ci-row");
      row.appendChild(el("span", "lr-ci-text", r.text));
      const b = el("button", "lr-again", "Run this job locally");
      b.type = "button";
      b.disabled = !v.can || !!s.starting;
      b.title = v.can ? `chant ci run plan --local --commit ${r.commit} --pr ${r.pr}${r.member ? ` in ${r.member}` : ""}` : v.refusal || "";
      b.addEventListener("click", () => {
        Object.assign(s.form, { commit: r.commit, pr: String(r.pr), member: r.member || "", base: "" });
        const a = askBody(s.form);
        if (a.body) ui.start(a.body);
      });
      row.appendChild(b);
      host.appendChild(row);
    }
  }

  // The runs behold started, newest first.
  const runs = (s.offer && s.offer.runs) || [];
  if (runs.length) {
    host.appendChild(el("h3", null, "run on this machine"));
    for (const r of runs) {
      const row = el("div", `lr-run${s.selected === r.id ? " lr-selected" : ""}`, `${sha8(r.commit)} · #${r.pull}${r.member ? ` · ${r.member}` : ""} · ${STATUS_WORDS[r.status] || r.status}`);
      row.title = r.title;
      row.tabIndex = 0;
      row.addEventListener("click", () => ui.pick(r.id));
      host.appendChild(row);
    }
  }
  if (!s.selected) return;

  // The run beside CI's run of the same job at the same commit.
  const heads = compareHeads(s.answer);
  const box = el("div", "lr-compare");
  const half = (title, answer, side) => {
    const col = el("div", "lr-half");
    col.appendChild(el("div", "lr-half-head", title));
    const pane = el("div", "lr-run-view");
    s.ui = s.ui || {};
    const u = (s.ui[side] = s.ui[side] || { job: null, open: null, setup: null });
    renderRun(pane, answer, u, {
      pickJob: (name) => {
        u.job = name;
        u.open = null;
        ui.redraw();
      },
      toggleStep: (job, i) => {
        u.job = job;
        u.open = i;
        ui.redraw();
      },
      toggleSetup: (key) => {
        u.setup = u.setup === key ? null : key;
        ui.redraw();
      },
    });
    col.appendChild(pane);
    box.appendChild(col);
  };
  half(heads.local, s.answer ? { doc: s.answer.doc, error: s.answer.error, absent: s.answer.absent } : null, "local");
  half(heads.ci, s.answer ? s.answer.ci || { absent: "no CI run to show" } : null, "ci");
  host.appendChild(box);
}

/**
 * Mount the tab's reads: the offer and the runs on open, chant's run index
 * when serve names one, and the selected run again whenever behold says it
 * moved (the SSE `local-run` event). `fetchJson(url, init)` answers parsed JSON.
 */
export function startLocalRuns(host, { fetchJson, events, toast = () => {} }) {
  const s = { offer: null, index: null, answer: null, selected: null, form: {}, starting: false };
  const redraw = () => renderLocalRuns(host, s, ui);
  const readOffer = async () => {
    s.offer = await fetchJson("/api/chant/ci/local").catch((e) => ({ error: String(e) }));
    if (s.offer && s.offer.offer && s.offer.offer.ciIndex && !s.index) s.index = await fetchJson("/api/chant/ci/runs").catch((e) => ({ error: String(e) }));
    redraw();
  };
  const readRun = async () => {
    if (!s.selected) return;
    const id = s.selected;
    const a = await fetchJson(`/api/chant/ci/local/${encodeURIComponent(id)}`).catch((e) => ({ error: String(e) }));
    if (s.selected !== id) return;
    s.answer = a;
    redraw();
  };
  const ui = {
    redraw,
    pick: (id) => {
      s.selected = id;
      s.answer = null;
      s.ui = {};
      redraw();
      readRun();
    },
    start: async (body) => {
      s.starting = true;
      s.formError = null;
      redraw();
      const r = await fetchJson("/api/chant/ci/local", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch((e) => ({ error: String(e) }));
      s.starting = false;
      if (r.error) {
        s.formError = r.error;
        toast(`✗ run locally: ${r.error}`, false);
        redraw();
        return;
      }
      toast(`▶ ${r.command}`, true);
      await readOffer();
      ui.pick(r.id);
    },
  };
  // One read per burst of lines.
  let pending = null;
  if (events) {
    events.addEventListener("local-run", (e) => {
      if (e.data !== s.selected || pending) return;
      pending = setTimeout(async () => {
        pending = null;
        await readRun();
        const a = s.answer && s.answer.doc;
        if (a && a.status !== "running" && a.status !== "queued") readOffer();
      }, 250);
    });
  }
  readOffer();
  return { reload: readOffer };
}
