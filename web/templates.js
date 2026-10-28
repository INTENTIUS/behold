// behold#1035: the Templates tab. One row per template the repo's catalog
// offers (GET /api/templates, terragucci templates list --json): its title,
// kind, newest version a request may name and that version's attestation. A
// row's Request button opens a form with one field per input, labelled from
// the template's template.yml; Submit posts POST /api/templates/request, which
// dispatches terragucci's request workflow. The run in CI opens the pull
// request; behold writes nothing. The tab is drawn only on a terragucci repo
// that sets templates, and never in a public view, an embed or a static export.
//
// behold#1036: an app's Add an add-on opens the tab for that app (`forApp`):
// only add-on templates are listed, each with Request, and the request posts
// `app` beside the add-on's name. terragucci adds the add-on to the app's root.

/** The tab's first line. */
export const TEMPLATES_LEGEND =
  "Apps this repo can make from a template. Fill in a template's form and Request: behold asks terragucci's request workflow to open a pull request that adds the app, and the pipeline plans it there for review. Nothing changes until that pull request is merged.";

/** What Submit says once the dispatch is accepted. */
export const REQUESTED_WORDS = "Requested. terragucci is opening the pull request.";

/** An add-on value naming an output of the app's own module. */
export const APP_OUTPUT_REF = /^app\.[A-Za-z_][A-Za-z0-9_-]*$/;

/** An app name, as chant's template request takes it. */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** The catalog's rows from the envelope GET /api/templates answers, or []. */
export function templateRows(answer) {
  return (answer && Array.isArray(answer.results) && answer.results) || [];
}

/** One row's line: title, kind, newest version and its attestation. */
export function rowFacts(row) {
  const newest = (row.versions || []).find((v) => v.version === row.latest) || (row.versions || [])[0];
  return { title: row.description || row.template, template: row.template, kind: row.kind, version: row.latest, attestation: newest ? newest.attestation : "unknown" };
}

/** The control a field is drawn with: text, number, checkbox, lines (one per line) or json. */
export function fieldControl(field) {
  if (field.kind === "number") return "number";
  if (field.kind === "bool") return "checkbox";
  if (field.kind === "list" && (!field.of || field.of === "string")) return "lines";
  if (field.kind === "list" || field.kind === "map" || field.kind === "object") return "json";
  return "text";
}

/** The fields a form asks for: a sensitive one is the app's secret store's, never the form's. */
export function formFields(row) {
  return (row.fields || []).filter((f) => !f.sensitive);
}

const blank = (v) => v === undefined || v === null || v === "";

/**
 * The request's inputs from the form's raw values (strings, and a boolean for
 * a checkbox): a number as a number, lines as a list, a JSON field parsed. An
 * empty optional field is left out, so the template's default holds. With
 * `appRefs` (an add-on's form) a value `app.<output>` stays as written: it
 * names an output of the app's own module, whatever the field's kind.
 */
export function formInputs(fields, raw, { appRefs = false } = {}) {
  const out = {};
  for (const f of fields) {
    const v = raw[f.name];
    const c = fieldControl(f);
    if (c === "checkbox") {
      if (v !== undefined) out[f.name] = !!v;
      continue;
    }
    if (blank(v)) continue;
    if (appRefs && APP_OUTPUT_REF.test(String(v).trim())) out[f.name] = String(v).trim();
    else if (c === "number") out[f.name] = Number(v);
    else if (c === "lines") out[f.name] = String(v).split("\n").map((s) => s.trim()).filter(Boolean);
    else if (c === "json") {
      try {
        out[f.name] = JSON.parse(String(v));
      } catch {
        out[f.name] = String(v);
      }
    } else out[f.name] = String(v);
  }
  return out;
}

/** Whether Submit may be pressed: a name, and a value in every required field. */
export function canSubmit(fields, raw, name) {
  if (!NAME_PATTERN.test(name || "")) return false;
  return fields.every((f) => !f.required || fieldControl(f) === "checkbox" || !blank(raw[f.name]));
}

/**
 * What the form says under Submit: `answer` is the POST's, `record` the
 * request's state from GET /api/templates/requests/:id. A pull request is a
 * link to `#<n>`; a refusal is its reason code and words.
 */
export function requestWords(answer, record) {
  if (!answer) return { text: "" };
  if (answer.error) return { text: `${answer.code ? `${answer.code}: ` : ""}${answer.error}${answer.command ? ` Run: ${answer.command}` : ""}`, refused: true };
  if (record && record.state === "ended") {
    if (typeof record.pull_request === "number") return { text: "terragucci opened the pull request", link: { href: record.url || "", text: `#${record.pull_request}` } };
    return { text: `The request run ended (${record.conclusion || "unknown"}) and no pull request is on ${record.branch}.${record.runUrl ? " The run's log says why." : ""}`, refused: true, ...(record.runUrl ? { link: { href: record.runUrl, text: "the run" } } : {}) };
  }
  return { text: REQUESTED_WORDS };
}

/** The rows the tab lists: every template, or for an app (`forApp`) its add-on templates only. */
export function listedRows(rows, forApp) {
  return forApp ? rows.filter((r) => r.kind === "addon") : rows;
}

/** The legend's line when the tab is open for one app. */
export const addonLegend = (app) => `Add-ons for ${app}. An add-on goes into ${app}'s own root, so the two are planned and applied together. Request one, and terragucci opens a pull request that adds it.`;

/** Draw the tab into `host`. `doc` is the document (a test hands in its own). */
export function renderTemplates(host, s, ui, doc = document) {
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  host.replaceChildren();
  host.appendChild(el("div", "tg-legend", TEMPLATES_LEGEND));
  const a = s.answer;
  if (!a) return void host.appendChild(el("div", "tg-legend", "reading the templates"));
  if (a.error && !a.results) return void host.appendChild(el("div", "tg-refusal", `${a.code ? `${a.code}: ` : ""}${a.error}`));
  if (s.forApp) {
    host.appendChild(el("div", "tg-legend tp-for-app", addonLegend(s.forApp)));
    const all = el("button", "tp-all", "Show every template");
    all.type = "button";
    all.addEventListener("click", () => ui.forApp(null));
    host.appendChild(all);
  }
  const rows = listedRows(templateRows(a), s.forApp);
  if (!rows.length) host.appendChild(el("div", "tg-legend", s.forApp ? "The catalog offers no add-on template with a version a request may name." : "The catalog offers no template with a version a request may name."));
  for (const row of rows) {
    const f = rowFacts(row);
    const card = el("div", "ad-card");
    card.appendChild(el("h3", null, f.title));
    card.appendChild(el("div", "tg-legend", `${f.template} · ${f.kind} · ${f.version} · ${f.attestation}`));
    const open = s.open === row.template;
    if ((s.forApp ? f.kind === "addon" : f.kind === "app") && !open) {
      const b = el("button", "tp-request", "Request");
      b.type = "button";
      b.addEventListener("click", () => ui.open(row.template));
      card.appendChild(b);
    }
    if (open) card.appendChild(renderForm(row, s, ui, el));
    host.appendChild(card);
  }
}

function renderForm(row, s, ui, el) {
  const fields = formFields(row);
  const form = el("form", "tp-form");
  const submit = el("button", "tp-submit", s.sending ? "Requesting" : "Submit");
  submit.type = "submit";
  const refresh = () => {
    submit.disabled = !!s.sending || !canSubmit(fields, s.raw, s.name);
  };
  const label = (text, required) => el("label", "ad-label", required ? `${text} (required)` : text);

  if (s.forApp) form.appendChild(el("div", "tg-legend tp-app", `into the app ${s.forApp}`));
  form.appendChild(label(s.forApp ? "Add-on name" : "App name", true));
  const name = el("input", "tp-name");
  name.type = "text";
  name.name = "name";
  name.required = true;
  name.value = s.name || "";
  name.placeholder = "a lowercase letter, then letters, digits and -";
  name.addEventListener("input", () => {
    s.name = name.value;
    refresh();
  });
  form.appendChild(name);

  for (const f of fields) {
    const c = fieldControl(f);
    form.appendChild(label(f.label || f.name, !!f.required && c !== "checkbox"));
    let input;
    if (c === "lines" || c === "json") {
      input = el("textarea", "tp-field");
      if (c === "lines") input.placeholder = "one per line";
    } else {
      input = el("input", "tp-field");
      input.type = c;
    }
    input.name = f.name;
    if (f.required && c !== "checkbox") input.required = true;
    if (f.description) input.title = f.description;
    const raw = s.raw[f.name];
    if (c === "checkbox") {
      input.checked = raw !== undefined ? !!raw : f.default === true;
      input.addEventListener("change", () => {
        s.raw[f.name] = input.checked;
        refresh();
      });
    } else {
      input.value = raw !== undefined ? String(raw) : "";
      if (f.default !== undefined && c !== "lines") input.placeholder = `default ${typeof f.default === "string" ? f.default : JSON.stringify(f.default)}`;
      input.addEventListener("input", () => {
        s.raw[f.name] = input.value;
        refresh();
      });
    }
    form.appendChild(input);
  }

  const row2 = el("div", "ad-row");
  row2.appendChild(submit);
  const cancel = el("button", null, "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => ui.close());
  row2.appendChild(cancel);
  form.appendChild(row2);
  form.addEventListener("submit", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (submit.disabled) return;
    ui.submit(row, formInputs(fields, s.raw, { appRefs: !!s.forApp }));
  });
  refresh();

  const words = requestWords(s.answerOf, s.record);
  if (words.text) {
    const out = el("div", words.refused ? "tg-refusal tp-result" : "tg-legend tp-result", words.text);
    if (words.link) {
      const a = el("a", "tp-pr", words.link.text);
      a.href = words.link.href;
      a.target = "_blank";
      a.rel = "noopener";
      out.appendChild(el("span", null, " "));
      out.appendChild(a);
    }
    form.appendChild(out);
  }
  return form;
}

/** Mount the tab. `fetchJson(url, init)` answers parsed JSON. */
export function startTemplates(host, { fetchJson, events, toast = () => {}, doc }) {
  const s = { answer: null, open: null, name: "", raw: {}, sending: false, answerOf: null, record: null, forApp: null };
  const redraw = () => renderTemplates(host, s, ui, doc);
  const read = async () => {
    s.answer = await fetchJson("/api/templates").catch((e) => ({ error: String(e) }));
    redraw();
  };
  const readRecord = async () => {
    const id = s.answerOf && s.answerOf.id;
    if (!id) return;
    s.record = await fetchJson(`/api/templates/requests/${encodeURIComponent(id)}`).catch(() => s.record);
    redraw();
  };
  const ui = {
    open: (template) => {
      Object.assign(s, { open: template, name: "", raw: {}, answerOf: null, record: null });
      redraw();
    },
    close: () => {
      s.open = null;
      redraw();
    },
    // behold#1036: the tab for one app's add-ons, or with null every template again.
    forApp: (app) => {
      Object.assign(s, { forApp: app || null, open: null, name: "", raw: {}, answerOf: null, record: null });
      redraw();
    },
    submit: async (row, inputs) => {
      s.sending = true;
      redraw();
      const body = { template: row.template, version: row.latest, name: s.name, ...(s.forApp ? { app: s.forApp } : {}), inputs };
      s.answerOf = await fetchJson("/api/templates/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch((e) => ({ error: String(e) }));
      s.sending = false;
      s.record = null;
      if (s.answerOf && s.answerOf.error) toast(`✗ request ${s.name}: ${s.answerOf.error}`, false);
      else toast(`▶ ${REQUESTED_WORDS}`, true);
      redraw();
      await readRecord();
    },
  };
  if (events) events.addEventListener("template-request", (e) => {
    if (s.answerOf && s.answerOf.id === e.data) readRecord();
  });
  read();
  return { reload: read, state: s, ui };
}
