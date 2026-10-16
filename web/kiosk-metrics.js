// behold#571: the kiosk's "Pipeline metrics" pane. The repo's numbers from
// Prometheus (/api/metrics, src/prometheus-metrics.ts): this run's waves, each
// with its roots' plan and apply time, the time an approval held it at its
// gate and what it applied, and the estate's four delivery (DORA) metrics.
//
// It shows what Prometheus returned and nothing else: with no Prometheus, or
// no number for the repo, there is no pane at all. A viewer can fold it to
// its header, which keeps a count; the fold is kept per viewer.
//
// The pane reads on its own: demo.json for the repo and commit the kiosk is
// on (on a tool's page, that tool's repo), then the metrics. All GET.
//
// The delivery numbers on the demo are the loop's own (terragucci's
// stack/demo.sh runs terragucci estate after each cycle's audit): demo.json's
// `delivery` line says so over them, and the section shows no line without one.

/** The localStorage key of the viewer's fold. */
export const METRICS_STORE = "behold.kiosk.metrics";

/** How often the pane asks again. The route shares one read for 30 s. */
export const METRICS_POLL_MS = 15_000;

const ACTION_WORDS = { create: "created", update: "updated", delete: "deleted", replace: "replaced", forget: "forgotten", import: "imported", move: "moved" };

/** "70 ms", "6.4 s", "48 s", "2 min 5 s", "1 h 20 min", "3 d 4 h". Below a second, milliseconds, so 0.07 s never reads as 0.1. */
export function secondsWords(secs) {
  if (typeof secs !== "number" || !Number.isFinite(secs) || secs < 0) return null;
  if (secs < 1) return `${Math.max(1, Math.round(secs * 1000))} ms`;
  if (secs < 10) return `${Math.round(secs * 10) / 10} s`;
  if (secs < 60) return `${Math.round(secs)} s`;
  const m = Math.floor(secs / 60);
  if (m < 60) {
    const s = Math.round(secs - m * 60);
    return s ? `${m} min ${s} s` : `${m} min`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** "10%", "8.3%". */
export function percentWords(ratio) {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return null;
  const p = ratio * 100;
  // behold#571: a rate above zero but under 0.1% keeps its first figure ("0.02%"), so one failure in thousands doesn't read as none.
  if (p > 0 && p < 0.1) return `${Number(p.toPrecision(1))}%`;
  return `${Math.round(p * 10) / 10}%`;
}

/** "4.5 a week". */
export function perWeekWords(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return `${Math.round(n * 10) / 10} a week`;
}

/** "2 created, 1 updated", in the order terragucci's actions read; null for none. */
export function changeWords(changes) {
  const parts = Object.entries(changes || {})
    // Only what changed a resource: a no-op or a read is not a change.
    .filter(([a, n]) => a in ACTION_WORDS && typeof n === "number" && n > 0)
    .sort((a, b) => Object.keys(ACTION_WORDS).indexOf(a[0]) - Object.keys(ACTION_WORDS).indexOf(b[0]))
    .map(([a, n]) => `${n} ${ACTION_WORDS[a] || a}`);
  return parts.length ? parts.join(", ") : null;
}

/** "14:05", the viewer's clock, from Unix seconds. */
export function clockWords(unix) {
  if (typeof unix !== "number" || !Number.isFinite(unix)) return null;
  const d = new Date(unix * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * What the pane shows, from one /api/metrics answer, or null for no pane:
 * `{ count, run: { label, waves: [{ head, rows: [[label, value, root?]] }] } | null, dora: [[label, value]] | null, note? }`.
 * `note` is the line over the delivery numbers, demo.json's `delivery`, when there are numbers and a line.
 */
export function metricsModel(answer, delivery = null) {
  if (!answer || answer.error) return null;
  let run = null;
  if (answer.run && Array.isArray(answer.run.waves)) {
    const waves = [];
    for (const w of answer.run.waves) {
      const rows = [];
      for (const r of w.roots || []) {
        const init = secondsWords(r.init_seconds);
        const lock = r.lock_wait_seconds > 0 ? secondsWords(r.lock_wait_seconds) : null;
        const plan = secondsWords(r.plan_seconds);
        const apply = secondsWords(r.apply_seconds);
        const parts = [init && `init ${init}`, lock && `lock wait ${lock}`, plan && `plan ${plan}`, apply && `apply ${apply}`].filter(Boolean);
        if (parts.length) rows.push([r.root, parts.join(" · "), r.root]);
      }
      const held = secondsWords(w.held_seconds);
      if (held) rows.push(["Held at the gate", held]);
      const since = clockWords(w.waiting_since);
      if (since) rows.push(["Waiting since", since]);
      const changed = changeWords(w.changes);
      if (changed) rows.push(["Applied", changed]);
      // The wave's job time leads: the binary's own runs are a small part of it.
      const took = secondsWords(w.seconds);
      // behold#571: Watch mode's badge on the wave's box reads the same numbers, short ("1.6 s · held 25 s · 4 created").
      const badge = { seconds: took, held, changed, secondsRaw: typeof w.seconds === "number" ? w.seconds : null, heldRaw: typeof w.held_seconds === "number" ? w.held_seconds : null, changesRaw: w.changes || null };
      if (rows.length || took) waves.push({ wave: w.wave, head: `Wave ${w.wave}`, took: took ? `${took} in all` : null, rows, ...badge });
    }
    if (waves.length) {
      const c = answer.run.commit ? ` · ${String(answer.run.commit).slice(0, 8)}` : "";
      run = { label: `${answer.run.current ? "This run" : "Latest run"}${c}`, current: !!answer.run.current, waves };
    }
  }
  let dora = null;
  if (answer.dora) {
    const d = answer.dora;
    const rows = [
      ["Deploys", perWeekWords(d.deployments_per_week)],
      ["Lead time", secondsWords(d.lead_time_seconds)],
      ["Change failure rate", percentWords(d.change_failure_ratio)],
      ["Time to restore", secondsWords(d.restore_seconds)],
    ].filter(([, v]) => v);
    if (rows.length) dora = rows;
  }
  if (!run && !dora) return null;
  const n = run ? run.waves.length : 0;
  const count = [n ? `${n} ${n === 1 ? "wave" : "waves"}` : null, dora ? `${dora.length} delivery` : null].filter(Boolean).join(" · ");
  const note = dora && typeof delivery === "string" && delivery.trim() ? delivery.trim() : null;
  return { count, run, dora, ...(note ? { note } : {}) };
}

/**
 * behold#571: the pane's presence holds steady through a cycle. Within one
 * cycle (`same`), or when a read failed (`failed`), an answer with less in it
 * keeps what the last one showed: no pane that comes and goes as the steps
 * move, and no section that drops out for one read. A new cycle with nothing
 * to show shows nothing.
 */
export function steadyModel(prev, next, { same = false, failed = false } = {}) {
  if (!prev) return next;
  if (!next) return same || failed ? prev : null;
  if (!(same || failed)) return next;
  const run = next.run || prev.run;
  const dora = next.dora || prev.dora;
  const note = next.note || (next.dora ? null : prev.note) || null;
  const n = run ? run.waves.length : 0;
  const count = [n ? `${n} ${n === 1 ? "wave" : "waves"}` : null, dora ? `${dora.length} delivery` : null].filter(Boolean).join(" · ");
  return { count, run, dora, ...(note ? { note } : {}) };
}

/** The viewer's fold: true open, false folded, null when they never chose. */
export function metricsStored(store) {
  try {
    const v = store && store.getItem(METRICS_STORE);
    return v === "open" ? true : v === "closed" ? false : null;
  } catch {
    return null;
  }
}

/** The repo and commit the pane is about: the narration's, or on a tool's page while another tool runs, that tool's newest cycle's repo. */
export function metricsTarget(demo, cycle, tool) {
  const d = demo && demo.demo;
  if (d && d.repo && (!tool || d.tool === tool)) return { repo: d.repo, commit: d.commit || null };
  if (tool && cycle && cycle.cycle && cycle.cycle.repo) return { repo: cycle.cycle.repo, commit: null };
  return null;
}

/** The URL the pane asks. */
export function metricsUrl(target) {
  const q = new URLSearchParams({ project: target.repo });
  if (target.commit && /^[0-9a-f]{7,64}$/.test(target.commit)) q.set("commit", target.commit);
  return `/api/metrics?${q}`;
}

const STYLE = `
#k-metrics { background: var(--surface-pane-b); border-radius: 6px; overflow-y: auto; min-height: 0; font-size: 0.9em; }
#k-metrics[hidden] { display: none; }
body.k-has-metrics #stage { grid-template-rows: minmax(0, 1fr) auto; }
body.k-has-metrics #runs-side { grid-row: 1; grid-column: 1; }
body.k-has-metrics #runs-main, body.k-has-metrics #view-pane { grid-row: 1 / span 2; }
body.k-has-metrics #k-metrics { grid-row: 2; grid-column: 1; max-height: 46vh; }
body.k-has-metrics.k-notyet #view-pane { grid-row: 1; }
.k-metrics-head { display: flex; width: 100%; gap: 0.6em; align-items: baseline; padding: 0.55em 1em; background: transparent; border: 0; color: var(--muted); cursor: pointer; text-align: left; font: 600 0.82em var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; }
.k-metrics-head:hover { color: var(--fg); }
.k-metrics-head::after { content: " \\25B8"; margin-left: auto; }
.k-metrics-open .k-metrics-head::after { content: " \\25BE"; }
.k-metrics-count { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--muted-ink, var(--muted)); }
.k-metrics-body { padding: 0 1em 0.7em; }
.k-metrics-label { margin: 0.35em 0 0.2em; font: 600 0.72em var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.k-metrics-waves { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.35em; }
.k-metrics-wave { background: var(--surface-box); border-radius: 6px; padding: 0.3em 0.6em 0.35em; }
.k-metrics-wave-head { display: flex; gap: 0.7em; align-items: baseline; font: 700 0.85em var(--font-mono); color: var(--fg); }
.k-metrics-took { margin-left: auto; font: 600 1.05em var(--font-ui); color: var(--fg); font-variant-numeric: tabular-nums; }
.k-metrics-rows { display: grid; grid-template-columns: minmax(0, 9.5em) minmax(0, 1fr); gap: 0.05em 0.7em; margin: 0.1em 0 0; }
.k-metrics-rows dt.k-metrics-root, .k-metrics-rows dt.k-metrics-root + dd { grid-column: 1 / -1; }
.k-metrics-rows dt.k-metrics-root + dd { padding-left: 0.8em; white-space: normal; }
.k-metrics-part { white-space: nowrap; }
.k-metrics-rows dt { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.k-metrics-rows dt.k-metrics-root { font-family: var(--font-mono); color: var(--fg); }
.k-metrics-rows dd { margin: 0; color: var(--fg); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.k-metrics-dora { background: var(--surface-box); border-radius: 6px; padding: 0.3em 0.6em 0.35em; }
.k-metrics-note { margin: 0 0 0.3em; color: var(--muted); font-size: 0.92em; line-height: 1.35; }
@media (max-width: 900px) and (min-width: 601px) { body.k-has-metrics #runs-main, body.k-has-metrics #view-pane { grid-row: auto; } body.k-has-metrics #k-metrics { grid-row: auto; grid-column: auto; } body.k-has-metrics #stage { grid-template-rows: none; } }
@media (max-width: 600px) { #k-metrics, body.k-has-metrics #k-metrics { order: 2; margin: 0.6em 16px 0; max-height: none; } }
`;

const el = (doc, tag, cls, text) => {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

function rowsEl(doc, rows, cls = "k-metrics-rows") {
  const dl = el(doc, "dl", cls);
  for (const [label, value, root] of rows) {
    const dt = el(doc, "dt", root ? "k-metrics-root" : null, label);
    if (root) dt.dataset.kRoot = root;
    dt.title = label;
    const dd = el(doc, "dd");
    // A root's timings wrap between parts, never inside one ("apply 58 ms").
    value.split(" · ").forEach((part, i) => {
      if (i) dd.append(" · ");
      dd.append(el(doc, "span", "k-metrics-part", part));
    });
    dl.append(dt, dd);
  }
  return dl;
}

/** Draw the pane from its model; null hides it. */
export function renderMetrics(host, model, { open = true, onToggle = () => {}, doc = document } = {}) {
  host.replaceChildren();
  host.hidden = !model;
  if (doc.body && doc.body.classList) doc.body.classList.toggle("k-has-metrics", !!model);
  if (!model) return;
  host.classList.toggle("k-metrics-open", open);
  const head = el(doc, "button", "k-metrics-head");
  head.type = "button";
  head.setAttribute("aria-expanded", String(open));
  head.append(el(doc, "span", null, "Pipeline metrics"), el(doc, "span", "k-metrics-count", model.count));
  head.addEventListener("click", () => onToggle(!open));
  host.appendChild(head);
  if (!open) return;
  const body = el(doc, "div", "k-metrics-body");
  if (model.run) {
    body.appendChild(el(doc, "h3", "k-metrics-label", model.run.label));
    const list = el(doc, "ol", "k-metrics-waves");
    for (const w of model.run.waves) {
      const li = el(doc, "li", "k-metrics-wave");
      li.dataset.kWave = String(w.wave);
      const head = el(doc, "div", "k-metrics-wave-head", w.head);
      if (w.took) head.append(el(doc, "span", "k-metrics-took", w.took));
      li.append(head);
      if (w.rows.length) li.append(rowsEl(doc, w.rows));
      list.appendChild(li);
    }
    body.appendChild(list);
  }
  if (model.dora) {
    body.appendChild(el(doc, "h3", "k-metrics-label", "Delivery (DORA)"));
    if (model.note) body.appendChild(el(doc, "p", "k-metrics-note", model.note));
    const box = el(doc, "div", "k-metrics-dora");
    box.appendChild(rowsEl(doc, model.dora));
    body.appendChild(box);
  }
  host.appendChild(body);
}

async function defaultFetch(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return { error: `${url} answered ${r.status}` };
    return await r.json();
  } catch (e) {
    return { error: String(e) };
  }
}

/**
 * Start the pane in `host`. `tool` is the tool of a tool's page, null on
 * /kiosk. Returns `{ stop }`.
 */
export function startMetrics(host, { tool = null, fetchJson = defaultFetch, store = null, setTimer = setInterval, clearTimer = clearInterval, doc = document, onModel = () => {} } = {}) {
  if (!host) return { stop() {} };
  if (doc.head && !doc.getElementById("k-metrics-style")) {
    const style = el(doc, "style");
    style.id = "k-metrics-style";
    style.textContent = STYLE;
    doc.head.appendChild(style);
  }
  const shelf = store || (() => { try { return localStorage; } catch { return null; } })();
  let open = metricsStored(shelf);
  if (open === null) open = !(typeof matchMedia === "function" && matchMedia("(max-width: 600px)").matches);
  let model = null;
  let cycle = null;
  let busy = false;
  const draw = () =>
    renderMetrics(host, model, {
      open,
      doc,
      onToggle: (next) => {
        open = next;
        try {
          if (shelf) shelf.setItem(METRICS_STORE, next ? "open" : "closed");
        } catch {
          /* private mode: the fold lasts this visit */
        }
        draw();
      },
    });
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const demo = await fetchJson("/api/terragucci/demo");
      const latest = tool && !(demo && demo.demo && demo.demo.tool === tool) ? await fetchJson(`/api/terragucci/cycles/${tool}`) : null;
      const target = metricsTarget(demo, latest, tool);
      const answer = target ? await fetchJson(metricsUrl(target)) : null;
      // behold#571: which cycle this read is of; a read that failed keeps the pane as it was.
      const d = demo && demo.demo;
      const now = d ? `${d.repo}|${d.cycle}` : latest && latest.cycle ? `${latest.cycle.repo}|${latest.cycle.cycle}` : null;
      const failed = !demo || !!demo.error || !target || !answer || !!answer.error;
      const next = steadyModel(model, target ? metricsModel(answer, d ? d.delivery : null) : null, { same: now !== null && now === cycle, failed });
      if (now !== null && !failed) cycle = now;
      if (JSON.stringify(next) !== JSON.stringify(model)) {
        model = next;
        draw();
        onModel(model);
      }
    } finally {
      busy = false;
    }
  };
  draw();
  void tick();
  const timer = setTimer(() => void tick(), METRICS_POLL_MS);
  return { stop: () => clearTimer(timer), tick, model: () => model };
}
