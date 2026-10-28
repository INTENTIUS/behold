// behold#1036: an app made from a template, the way its owner thinks of it.
// GET /api/templates/apps (terragucci templates apps --json) names each app's
// root, its template and version, and its add-ons. An app and its add-ons are
// one root, planned and applied together (ruling C of INTENTIUS/chant#4642):
// `module "app"` is the app's template and each `module "<addon>"` an add-on.
// So on the graph their cards draw inside one frame, titled with the app's
// name and template, and the frame's header counts the cards terragucci's
// reports mark as drifted. The marks stay on the cards themselves.
//
// The app's inspect pane offers the requests that change it: Add an add-on
// (the Templates form, filtered to add-on templates, with the app set) and
// Upgrade to <version> when the catalog has a newer active version, which
// dispatches terragucci's rollout workflow. behold applies nothing. Neither
// button is drawn in a public view, an embed or a static export.
//
// Pure, apart from renderAppSection, which draws into the document it is handed.

/** The apps from the envelope GET /api/templates/apps answers, or []. */
export function appRows(answer) {
  return (answer && Array.isArray(answer.results) && answer.results) || [];
}

/** A template's short name, as a request branch names it: `bucket` for `acme/bucket/aws`. */
export function templateShort(template) {
  const parts = String(template || "").split("/").filter(Boolean);
  return (parts.length >= 3 ? parts[parts.length - 2] : parts[parts.length - 1]) || String(template || "");
}

/** The frame's title: `orders (bucket 1.2.0)`. */
export function frameTitle(app) {
  return `${app.app} (${templateShort(app.template)}${app.version ? ` ${app.version}` : ""})`;
}

/** The module calls of an app's root: `module.app` and each add-on's. */
export function appModules(app) {
  return ["app", ...(app.addons || []).map((a) => a.name)].map((n) => `module.${n}`);
}

/**
 * The card-id prefix of an app's root: `<member>/<root name>/`. The roots
 * table (/api/terragucci's `roots`, each `{member, name, path}`) names it when
 * there is one; else a card whose `attrs.root` is the root's last path
 * segment, or its path with `-` for `/`, as behold names a root it discovers.
 */
export function rootPrefix(app, roots, nodes) {
  const hit = (roots || []).find((r) => r.path === app.root);
  if (hit) return `${hit.member}/${hit.name}/`;
  const names = [app.root.split("/").pop(), app.root.split("/").join("-")];
  for (const n of nodes || []) {
    const root = n.attrs && n.attrs.root;
    if (typeof root !== "string" || !names.includes(root)) continue;
    const at = n.id.indexOf(`/${root}/`);
    if (at >= 0) return n.id.slice(0, at + root.length + 2);
  }
  return null;
}

/** Whether a card mark says drift. */
const drifted = (marks) => (marks || []).some((m) => m.verdict === "drift");

/**
 * One frame per app whose cards are on the graph: the app, its title, the
 * card ids of `module.app` and its add-ons, how many of them carry a drift
 * mark (`cards` is /api/terragucci's marks by card id), and the header's
 * words. An app none of whose cards is drawn gets no frame.
 */
export function appFrames(apps, nodes, { roots = [], cards = {} } = {}) {
  const out = [];
  for (const app of apps || []) {
    const prefix = rootPrefix(app, roots, nodes);
    if (!prefix) continue;
    const modules = appModules(app);
    const ids = (nodes || [])
      .map((n) => n.id)
      .filter((id) => id.startsWith(prefix) && modules.some((m) => id.slice(prefix.length) === m || id.slice(prefix.length).startsWith(`${m}/`)));
    if (!ids.length) continue;
    const drift = ids.filter((id) => drifted(cards[id])).length;
    const title = frameTitle(app);
    out.push({ app, title, prefix, ids, drifted: drift, header: drift ? `${title} · ${drift} drifted` : title, ...(drift ? { drift: `${drift} drifted` } : {}) });
  }
  return out;
}

/** The frame a card is in, or null. */
export function frameOf(frames, id) {
  return (frames || []).find((f) => f.ids.includes(id)) || null;
}

/**
 * The buttons an app's inspect pane draws, in order: Add an add-on, then
 * Upgrade to <version> when the catalog offers one. None in a public view,
 * an embed or a static export. Each is `{id, label, title}`, plus what its
 * request sends; a later kind of request (an action) is one more entry here.
 */
export function appButtons(app, { publicMode = false, embed = false, staticMode = false } = {}) {
  if (publicMode || embed || staticMode || !app) return [];
  const out = [{ id: "addon", label: "Add an add-on", title: `Open the Templates form with only add-on templates, for ${app.app}. terragucci opens the pull request that adds the add-on to ${app.root}.` }];
  if (typeof app.upgrade === "string" && app.upgrade) {
    out.push({
      id: "upgrade",
      label: `Upgrade to ${app.upgrade}`,
      title: `Start the rollout of ${app.template} ${app.upgrade}: terragucci opens one pull request per wave, and every app on ${templateShort(app.template)} moves with it. Each wave is planned, reviewed and applied by the pipeline.`,
      body: { app: app.app, version: app.upgrade },
    });
  }
  return out;
}

/** The app's facts, one line each: template and version, add-ons, drift, a yanked pin. */
export function appFacts(frame) {
  const a = frame.app;
  const lines = [`${a.template} ${a.version || "unpinned"}${a.yanked ? " (yanked)" : ""} · ${a.root}`];
  const addons = (a.addons || []).map((x) => `${x.name} (${templateShort(x.template)}${x.version ? ` ${x.version}` : ""})`);
  lines.push(addons.length ? `add-ons: ${addons.join(", ")}` : "no add-ons");
  if (frame.drifted) lines.push(`${frame.drifted} card${frame.drifted === 1 ? "" : "s"} drifted, from terragucci's reports`);
  return lines;
}

/** What the pane says once Upgrade was pressed: the POST's answer, or a refusal's code and words. */
export function upgradeWords(answer) {
  if (!answer) return { text: "" };
  if (answer.error) return { text: `${answer.code ? `${answer.code}: ` : ""}${answer.error}${answer.command ? ` Run: ${answer.command}` : ""}`, refused: true };
  return { text: `Upgrade started: terragucci opens the first wave's pull request for ${answer.template} ${answer.version}, and the rollout carries the rest wave by wave.` };
}

/**
 * Draw the app's part of the inspect pane into `host`: its title, facts and
 * buttons. `ui.addAddon(app)` and `ui.upgrade(app, body)` are what the buttons
 * call; `said` is the last upgrade's answer, for its words. `doc` is the
 * document (a test hands in its own).
 */
export function renderAppSection(host, frame, ui, opts = {}, doc = document) {
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const box = el("section", "tpl-app");
  box.appendChild(el("h3", null, `app ${frame.title}`));
  for (const line of appFacts(frame)) box.appendChild(el("p", "tpl-app-fact", line));
  const buttons = appButtons(frame.app, opts);
  if (buttons.length) {
    const row = el("div", "tpl-app-buttons");
    for (const b of buttons) {
      const n = el("button", `tpl-app-${b.id}`, b.label);
      n.type = "button";
      n.title = b.title;
      n.setAttribute("data-action", b.id);
      n.addEventListener("click", () => {
        if (b.id === "addon") ui.addAddon(frame.app);
        else if (b.id === "upgrade") ui.upgrade(frame.app, b.body);
        else if (ui.action) ui.action(frame.app, b);
      });
      row.appendChild(n);
    }
    box.appendChild(row);
  }
  const words = upgradeWords(opts.said);
  if (words.text) box.appendChild(el("p", words.refused ? "tg-refusal tpl-app-result" : "tg-legend tpl-app-result", words.text));
  host.appendChild(box);
  return box;
}

/** Press Upgrade: POST /api/templates/upgrade with the app and the version the pane showed. `fetchJson(url, init)` answers parsed JSON. */
export function postUpgrade(fetchJson, body) {
  return fetchJson("/api/templates/upgrade", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch((e) => ({ error: String(e) }));
}
