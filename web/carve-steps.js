// The carve walkthrough's stepper (#254, M1.5 of #230) — the panel's Carve tab.
//
// Six steps over one estate: advise → pick → emit → bridge → handoff → done.
// behold runs the two SAFE ones (emit, bridge — both write only into the demo
// copy, both read-only with respect to your Terraform) and deliberately does
// NOT run the destructive middle: `terraform state rm` releases Terraform's
// claim on a live resource, and that stays a human decision made in a human's
// terminal. Step 5 is a list of commands with copy buttons, and it says why.
//
// Same discipline as web/json-view.js and web/layout-store.js: everything the
// stepper DECIDES lives in a pure function that takes data and returns data, so
// it is unit-testable next door in carve-steps.test.js; the DOM half below is
// smoke/ui-smoke.mjs's job.
//
// The walkthrough's state is client-side only, exactly as #254 specifies — the
// server holds no session. Reload and you are back at Advise, with whatever the
// previous run already wrote still sitting in the demo copy.

/** The six steps, in order. `id` is the stable handle (tests, the ⌘K twins). */
export const CARVE_STEPS = [
  {
    id: "advise",
    label: "Advise",
    blurb: "chant scored every resource in the Terraform half. Green carves cheaply; grey stays where it is.",
  },
  {
    id: "pick",
    label: "Pick",
    blurb: "Click a green card in the graph. The inspect pane shows the arithmetic behind its score.",
  },
  {
    id: "emit",
    label: "Emit",
    blurb: "Adopt it from the tfstate into typed chant source. Nothing is applied and nothing is destroyed.",
  },
  {
    id: "bridge",
    label: "Bridge",
    blurb: "Generate the surviving Terraform's patch — a data source, and the references rewired to read it.",
  },
  {
    id: "handoff",
    label: "Handoff",
    blurb: "Two commands you run yourself. behold copies them; it does not press them.",
  },
  {
    id: "done",
    label: "Done",
    blurb: "chant-owned, observe position. `terraform import` reverses all of it.",
  },
];

/** A fresh walkthrough. */
export function initialCarveState() {
  return {
    /** Index into CARVE_STEPS. */
    step: 0,
    /** The report resource the user picked, plus its IR node. */
    pick: null,
    /** POST /api/carve/emit's answer. */
    emit: null,
    /** POST /api/carve/bridge's answer. */
    bridge: null,
    /** Set when the user says they ran the handoff commands. */
    handoff: false,
    /** Which step is mid-run ("emit" | "bridge" | null) — the dial's progress. */
    busy: null,
    /** The last structured refusal, keyed by step id. */
    error: null,
  };
}

/** Has this step's work actually happened? Distinct from "we walked past it". */
export function completed(state, id) {
  switch (id) {
    case "advise":
      return state.step > 0;
    case "pick":
      return !!state.pick;
    case "emit":
      return !!state.emit;
    case "bridge":
      return !!state.bridge;
    case "handoff":
      return !!state.handoff;
    case "done":
      return !!state.handoff && !!state.bridge;
    default:
      return false;
  }
}

/**
 * Why this step can't be entered yet, or null. The gates are the real data
 * dependencies, not a wizard's insistence on order: bridge genuinely reads the
 * carve manifest emit leaves in the output directory, and the runbook genuinely
 * does not exist until bridge writes it.
 */
export function blockedReason(state, id) {
  switch (id) {
    case "emit":
      return state.pick ? null : "Pick a resource first — Emit carves the one you selected.";
    case "bridge":
      return state.emit ? null : "Run Emit first — bridge reads the carve manifest emit leaves in the output directory.";
    case "handoff":
      return state.bridge ? null : "Run Bridge first — the runbook is the file it writes.";
    case "done":
      return state.bridge ? null : "The carve isn't proposed yet — Emit and Bridge come first.";
    default:
      return null;
  }
}

/** How a step's button paints: current | done | blocked | todo. */
export function stepStatus(state, index) {
  const id = CARVE_STEPS[index] && CARVE_STEPS[index].id;
  if (!id) return "todo";
  if (state.step === index) return "current";
  if (completed(state, id)) return "done";
  return blockedReason(state, id) ? "blocked" : "todo";
}

/** Every boundary edge a report resource declares, in either shape chant may
 * publish (a flat list, or split by direction). Mirrors src/carve-lens.ts's
 * `boundaryEdgesOf` — the same leniency, for the same reason. */
export function boundaryEdgesOf(resource) {
  const b = resource && resource.boundary;
  if (!b) return [];
  const list = Array.isArray(b) ? b : [...(b.inbound || []), ...(b.outbound || [])];
  return list.filter((e) => e && typeof e.survivor === "string" && typeof e.carved === "string");
}

/** One boundary edge as a sentence. */
export function edgeLine(e) {
  const dir = e.direction === "outbound" ? "outbound" : "inbound";
  const attrs = (e.attrs || []).join(", ");
  const via = (e.via || []).join(", ");
  const head =
    dir === "inbound"
      ? `${e.survivor} reads ${attrs || "this resource"}`
      : `this resource reads ${attrs || "something"} from ${e.survivor}`;
  const where = via ? ` (in its ${via})` : "";
  // Three bridge shapes chant hands back, not two: a survivor's own reference
  // becomes a data source (`tf-data-source`) or a deploy-time input
  // (`deferred-input`); an `output` block reading the carved resource becomes
  // a one-line rewrite instead (`tf-output-rewrite`, chant#1638) — it is
  // neither of the other two, and defaulting it to "data source" would name
  // the wrong fix for a line that was never a data block to begin with.
  const fix =
    e.bridge === "deferred-input"
      ? "becomes a deploy-time input"
      : e.bridge === "tf-output-rewrite"
        ? "becomes a one-line output rewrite"
        : "becomes a Terraform data source";
  const when = e.required === "at-apply" ? ", deferred until apply" : e.required === "immediately" ? ", needed immediately" : "";
  return `${dir} — ${head}${where} → ${fix}${when}`;
}

/**
 * What the Pick step can honestly say about the cut this carve would make.
 *
 * `known: true` when the report carries the edge lists (chant#1636) — then the
 * survivors are named. `known: false` on every chant that publishes only the
 * per-resource COUNTS, and then the step says the counts, names the cut from
 * the breakdown, and says plainly that the survivors aren't in this report
 * rather than inventing them. "None" and "not reported" are different claims,
 * and a walkthrough that blurs them teaches the wrong thing about the tool.
 */
export function cutSummary(resource, node) {
  const edges = boundaryEdgesOf(resource);
  if (edges.length) {
    return { known: true, items: edges.map(edgeLine), note: null };
  }
  // The counts come off the raw report when it's in hand and off the IR node's
  // own attrs otherwise — the lens puts `inbound`/`outbound` on every card, so
  // the step never has to wait for the extra `/api/carve` fetch to say
  // something true. (`??`, not `||`: a real 0 is an answer.)
  const attrs = (node && node.attrs) || {};
  const b = (resource && resource.breakdown) || {};
  const inbound = b.inbound ?? attrs.inbound ?? 0;
  const outbound = b.outbound ?? attrs.outbound ?? 0;
  const items = [];
  if (inbound) items.push(`${inbound} inbound — a survivor reads this; each needs a Terraform data-source patch, immediately.`);
  if (outbound) items.push(`${outbound} outbound — this reads a survivor; each becomes a deferred deploy-time input.`);
  if (!items.length) items.push("No boundary edges at all — nothing to patch, nothing to defer.");
  return {
    known: false,
    items,
    note:
      inbound || outbound
        ? "This report carries boundary COUNTS, not the edge lists (chant#1636), so the survivors can't be named here. " +
          "The Emit step's own boundary report names them."
        : null,
  };
}

/** The facts the Pick step shows about the selected resource. `node` is the IR
 * node (which already carries the arithmetic the lens spelled out); `resource`
 * is the raw report entry. Either may be missing. */
export function pickFacts(node, resource) {
  const attrs = (node && node.attrs) || {};
  const b = (resource && resource.breakdown) || {};
  const facts = [
    ["address", (resource && resource.address) || (node && node.id) || "—"],
    ["score", `${resource ? resource.score : attrs.score} — ${resource ? resource.band : attrs.band}`],
  ];
  if (attrs.arithmetic) facts.push(["arithmetic", String(attrs.arithmetic)]);
  const mapsTo = (resource && resource.mapsTo) || attrs.mapsTo;
  if (mapsTo) facts.push(["maps to", String(mapsTo)]);
  if (b.tier || attrs.tier) facts.push(["tier", String(b.tier ?? attrs.tier)]);
  return facts.map(([label, value]) => ({ label, value: String(value) }));
}

/** Is this resource one the walkthrough can actually carve? A grey card with no
 * native mapping scores 0 and `carve emit` refuses it — say so at Pick time
 * rather than letting the Emit button produce chant's error. */
export function carveable(resource, node) {
  const attrs = (node && node.attrs) || {};
  const tier = resource && resource.breakdown ? resource.breakdown.tier : attrs.tier;
  const mapsTo = (resource && resource.mapsTo) || attrs.mapsTo;
  if (tier === null || tier === "none" || tier === undefined) {
    if (!mapsTo) return "no known native mapping — chant has nothing to carve this into, so Emit would refuse.";
  }
  return null;
}

/**
 * The runnable commands out of a `carve bridge` runbook, in order, deduped.
 *
 * chant's runbook is markdown: `## <n>. <heading>` sections whose commands are
 * indented four spaces. Annotations (a `#` comment, a parenthetical) sit at the
 * same indent, so they are dropped from the command list and a trailing `# …`
 * is kept as the row's note. Deduped on the command text — the runbook prints
 * `terraform plan` twice on purpose, and two identical copy buttons are noise.
 */
export function runbookCommands(markdown) {
  const out = [];
  const seen = new Set();
  let section = "";
  for (const raw of String(markdown || "").split(/\r?\n/)) {
    const heading = /^#{2,3}\s+(.*\S)\s*$/.exec(raw);
    if (heading) {
      section = heading[1];
      continue;
    }
    const indented = /^ {4}(\S.*?)\s*$/.exec(raw);
    if (!indented) continue;
    const body = indented[1];
    if (body.startsWith("#") || body.startsWith("(")) continue;
    const hash = body.indexOf(" #");
    const command = (hash > 0 ? body.slice(0, hash) : body).trim();
    const note = hash > 0 ? body.slice(hash + 2).trim() : "";
    if (!command || seen.has(command)) continue;
    seen.add(command);
    out.push({ section, command, note });
  }
  return out;
}

/** How `chant lint` reads on the Emit panel. */
export function lintVerdict(lint) {
  if (!lint) return null;
  // chant's own summary line (`⚠ 3 warnings`), not the per-finding lines above
  // it — an unanchored `(\d+) warnings?` happily matches the column number in
  // `5:1    warning  …` and reports "1 warning" for a file with three.
  const warnings = /^\s*\S?\s*(\d+)\s+warnings?\b/m.exec(lint.output || "");
  if (lint.ok) {
    return {
      tone: "good",
      text: warnings ? `chant lint: passes, ${warnings[1]} warning(s)` : "chant lint: passes",
    };
  }
  return { tone: "bad", text: `chant lint exited ${lint.code} — the emitted source doesn't pass yet` };
}

// ---------------------------------------------------------------------------
// The DOM half. Plain browser JS, no build step, themed entirely by the shared
// CSS vars — same rules as app.js. `actions` is the host's wiring:
//   { go(index), runEmit(), runBridge(), markHandoff(), reset(), select(id), copy(text, el) }
// ---------------------------------------------------------------------------

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function stepTrack(state, actions) {
  const track = el("div", "dial-track");
  CARVE_STEPS.forEach((s, i) => {
    if (i) track.appendChild(el("span", "dial-arrow", "→"));
    const status = stepStatus(state, i);
    const running = state.busy === s.id;
    const b = el("button", `dial-step carve-step ${status}`, running ? `${s.label} · running…` : status === "done" ? `${s.label} ✓` : s.label);
    b.dataset.step = s.id;
    b.dataset.status = status;
    b.title = blockedReason(state, s.id) || s.blurb;
    b.disabled = !!state.busy;
    b.addEventListener("click", () => actions.go(i));
    track.appendChild(b);
  });
  return track;
}

function factRows(facts) {
  const wrap = el("div");
  for (const f of facts) {
    const row = el("div", "count-row");
    row.appendChild(el("span", "grow", f.label));
    row.appendChild(el("span", "tag", f.value));
    wrap.appendChild(row);
  }
  return wrap;
}

/** A code block. Always textContent — every string here is chant's own output
 * or a file off disk, and none of it is markup. */
function pre(text, cls) {
  const p = el("pre", `carve-pre${cls ? " " + cls : ""}`);
  p.textContent = String(text || "");
  return p;
}

function copyButton(label, text, actions) {
  const b = el("button", "act carve-copy", label);
  b.title = "Copy to the clipboard";
  b.addEventListener("click", () => actions.copy(text, b));
  return b;
}

function artifactBlock(a, actions) {
  const wrap = el("div", "carve-artifact");
  const head = el("div", "prow");
  head.appendChild(el("span", "grow carve-path", a.path));
  head.appendChild(el("span", "tag", `${a.bytes} B${a.truncated ? " (truncated)" : ""}`));
  head.appendChild(copyButton("copy", a.text, actions));
  wrap.append(head, pre(a.text, `lang-${a.kind}`));
  return wrap;
}

function refusalBlock(err) {
  const wrap = el("div", "carve-refusal");
  wrap.appendChild(el("div", "carve-refusal-title", err.error || "that step didn't run"));
  if (err.remedy) wrap.appendChild(el("p", "panel-muted", err.remedy));
  return wrap;
}

/**
 * Render the whole tab. `ctx` carries what the host knows and the stepper does
 * not: the demo info off /api/project, the raw report, the picked IR node, and
 * `renderJson` (web/json-view.js — the boundary report and the bridge plan are
 * JSON, and every JSON value this page shows goes through one renderer).
 */
export function renderCarvePanel(host, state, ctx, actions) {
  host.innerHTML = "";
  const demo = ctx.demo || null;

  host.appendChild(stepTrack(state, actions));

  if (demo && demo.degraded) {
    const warn = el("div", "carve-refusal");
    warn.appendChild(el("div", "carve-refusal-title", "The demo's own advisor run didn't happen"));
    warn.appendChild(el("p", "panel-muted", demo.degraded));
    host.appendChild(warn);
  }

  const step = CARVE_STEPS[state.step] || CARVE_STEPS[0];
  const body = el("div", "carve-body");
  body.dataset.step = step.id;
  host.appendChild(body);
  body.appendChild(el("p", "panel-muted", step.blurb));

  if (state.error && state.error.step === step.id) body.appendChild(refusalBlock(state.error));

  const renderers = {
    advise: () => renderAdvise(body, ctx),
    pick: () => renderPick(body, state, ctx, actions),
    emit: () => renderEmit(body, state, ctx, actions),
    bridge: () => renderBridge(body, state, ctx, actions),
    handoff: () => renderHandoff(body, state, actions),
    done: () => renderDone(body, state, ctx, actions),
  };
  renderers[step.id]();

  // Forward/back, so the whole thing is walkable without aiming at the track.
  const nav = el("div", "prow carve-nav");
  if (state.step > 0) {
    const back = el("button", "act", "← back");
    back.addEventListener("click", () => actions.go(state.step - 1));
    nav.appendChild(back);
  }
  if (state.step < CARVE_STEPS.length - 1) {
    const nextId = CARVE_STEPS[state.step + 1].id;
    const why = blockedReason(state, nextId);
    const next = el("button", "act carve-next", `next: ${CARVE_STEPS[state.step + 1].label} →`);
    next.disabled = !!why || !!state.busy;
    if (why) next.title = why;
    next.addEventListener("click", () => actions.go(state.step + 1));
    nav.appendChild(next);
  }
  host.appendChild(nav);
}

function renderAdvise(body, ctx) {
  const bands = (ctx.carve && ctx.carve.bands) || {};
  body.appendChild(el("h3", null, "bands"));
  const legend = [
    ["clean leaf", "var(--managed)", "carve now — 80-100"],
    ["carvable w/ edits", "var(--pending)", "boundary work — 50-79"],
    ["leave in Terraform", "var(--muted)", "leave — 0-49"],
  ];
  for (const [band, color, meaning] of legend) {
    const row = el("div", "count-row");
    const dot = el("span", "dot");
    dot.style.background = color;
    row.append(dot, el("span", "grow", meaning), el("span", "tag", String(bands[band] ?? 0)));
    body.appendChild(row);
  }
  if (ctx.carve && ctx.carve.advisory) body.appendChild(el("p", "panel-muted", ctx.carve.advisory));
  if (ctx.demo) {
    body.appendChild(
      el(
        "p",
        "panel-muted",
        `Terraform read from ${ctx.demo.fromLabel}/ in your demo copy. Emit and bridge write only into ${ctx.demo.outLabel}/.`,
      ),
    );
  }
}

function renderPick(body, state, ctx, actions) {
  if (!state.pick) {
    body.appendChild(el("p", "panel-muted", "Nothing picked yet. Click a green card in the graph, or one of these:"));
    const greens = (ctx.report && ctx.report.resources ? ctx.report.resources : []).filter((r) => r.score >= 80);
    for (const r of greens) {
      const row = el("div", "node-row");
      const dot = el("span", "dot");
      dot.style.background = "var(--managed)";
      row.append(dot, el("span", "grow", r.address), el("span", "tag", String(r.score)));
      row.addEventListener("click", () => actions.select(r.address));
      body.appendChild(row);
    }
    return;
  }
  const { node, resource } = state.pick;
  body.appendChild(el("h3", null, "the arithmetic"));
  body.appendChild(factRows(pickFacts(node, resource)));

  const cut = cutSummary(resource, node);
  body.appendChild(el("h3", null, cut.known ? "the edges this cut severs" : "the boundary this cut crosses"));
  for (const item of cut.items) body.appendChild(el("p", "panel-muted carve-cut", item));
  if (cut.note) body.appendChild(el("p", "panel-muted carve-honesty", cut.note));

  const why = carveable(resource, node);
  if (why) body.appendChild(el("p", "panel-muted carve-honesty", why));
}

function renderEmit(body, state, ctx, actions) {
  const demo = ctx.demo;
  if (!demo || !demo.runnable) {
    body.appendChild(
      el("p", "panel-muted", demo ? demo.reason : "This is a plain `behold carve` — the steps run only inside a `behold demo carve` copy."),
    );
    return;
  }
  if (!state.emit) {
    // Two different "no"s, and they read differently: not picked yet, versus
    // picked something chant has no native mapping for. The second one is
    // chant's own refusal, said here instead of after a round trip.
    const why = blockedReason(state, "emit") || (state.pick ? carveable(state.pick.resource, state.pick.node) : null);
    const run = el("button", "act carve-run", state.busy === "emit" ? "emitting…" : `Emit ${state.pick ? state.pick.node.id : ""} →`);
    run.disabled = !!why || !!state.busy;
    if (why) run.title = why;
    if (why) body.appendChild(el("p", "panel-muted carve-honesty", why));
    run.addEventListener("click", actions.runEmit);
    body.appendChild(run);
    body.appendChild(
      el(
        "p",
        "panel-muted",
        "Runs `chant carve emit --state --select <addr>` in your demo copy. It adopts the resource from the tfstate " +
          "into typed chant source — nothing is applied, nothing is destroyed, and your Terraform is not touched.",
      ),
    );
    return;
  }
  const e = state.emit;
  body.appendChild(pre(e.command, "carve-cmd"));
  body.appendChild(pre(e.output));

  const verdict = lintVerdict(e.lint);
  if (verdict) {
    const row = el("div", "count-row");
    const dot = el("span", "dot");
    dot.style.background = verdict.tone === "good" ? "var(--managed)" : "var(--degraded)";
    row.append(dot, el("span", "grow", verdict.text), el("span", "tag", e.lint.command));
    body.appendChild(row);
    body.appendChild(pre(e.lint.output));
  }
  // chant#1637, said where it matters rather than only in a README nobody has
  // open: this step shows `lint` and not `build`, and here is why.
  const caveat = el("details", "carve-caveat");
  caveat.appendChild(el("summary", null, "why lint and not build?"));
  caveat.appendChild(el("p", "panel-muted", e.buildCaveat || (ctx.demo && ctx.demo.buildCaveat) || ""));
  body.appendChild(caveat);

  body.appendChild(el("h3", null, "emitted"));
  for (const a of e.artifacts || []) body.appendChild(artifactBlock(a, actions));

  if (e.boundary) {
    body.appendChild(el("h3", null, "boundary report"));
    body.appendChild(ctx.renderJson(e.boundary));
  }
}

function renderBridge(body, state, ctx, actions) {
  const demo = ctx.demo;
  if (!demo || !demo.runnable) {
    body.appendChild(el("p", "panel-muted", demo ? demo.reason : "The steps run only inside a `behold demo carve` copy."));
    return;
  }
  if (!state.bridge) {
    const why = blockedReason(state, "bridge");
    const run = el("button", "act carve-run", state.busy === "bridge" ? "bridging…" : "Bridge →");
    run.disabled = !!why || !!state.busy;
    if (why) run.title = why;
    run.addEventListener("click", actions.runBridge);
    body.appendChild(run);
    body.appendChild(
      el(
        "p",
        "panel-muted",
        "Runs `chant carve bridge` WITHOUT --apply-rewrites: the rewritten Terraform lands beside the runbook as a " +
          "proposal, and your own `.tf` files are never edited.",
      ),
    );
    return;
  }
  const b = state.bridge;
  body.appendChild(pre(b.command, "carve-cmd"));
  body.appendChild(pre(b.output));
  body.appendChild(el("h3", null, "proposed"));
  for (const a of b.proposals || []) body.appendChild(artifactBlock(a, actions));
}

function renderHandoff(body, state, actions) {
  const runbook = state.bridge && state.bridge.runbook;
  if (!runbook) {
    body.appendChild(el("p", "panel-muted", blockedReason(state, "handoff") || "no runbook yet"));
    return;
  }
  // The one place the walkthrough refuses to be a button, stated out loud.
  const why = el("div", "carve-refusal carve-human");
  why.appendChild(el("div", "carve-refusal-title", "These two are not buttons, on purpose."));
  why.appendChild(
    el(
      "p",
      "panel-muted",
      "`terraform state rm` releases Terraform's claim on a live resource, and `terraform apply` writes to your cloud. " +
        "behold triggers delegated work; it does not decide when your estate changes hands. Copy them, read the plan, " +
        "and run them yourself.",
    ),
  );
  body.appendChild(why);

  body.appendChild(el("h3", null, "the runbook"));
  let section = null;
  for (const c of runbookCommands(runbook.text)) {
    if (c.section !== section) {
      section = c.section;
      body.appendChild(el("p", "panel-muted carve-section", section));
    }
    const row = el("div", "prow carve-cmd-row");
    row.appendChild(el("code", "grow carve-cmd-text", c.command));
    row.appendChild(copyButton("copy", c.command, actions));
    body.appendChild(row);
    if (c.note) body.appendChild(el("p", "panel-muted carve-cmd-note", c.note));
  }

  const ran = el("button", "act carve-ran", state.handoff ? "✓ marked as run" : "I ran these →");
  ran.title = "Marks the handoff done in this walkthrough. behold has not checked — it can't, and won't pretend to.";
  ran.addEventListener("click", actions.markHandoff);
  body.appendChild(ran);

  const full = el("details", "carve-caveat");
  full.appendChild(el("summary", null, `the whole runbook (${runbook.path})`));
  full.appendChild(pre(runbook.text));
  body.appendChild(full);
}

function renderDone(body, state, ctx, actions) {
  const address = state.pick ? state.pick.node.id : "the resource";
  const card = el("div", "carve-endcard");
  card.appendChild(el("div", "carve-endcard-title", `${address} — chant-owned, observe position.`));
  card.appendChild(
    el(
      "p",
      "panel-muted",
      "Nothing was destroyed and nothing was recreated. `terraform import` puts it back under Terraform at any point.",
    ),
  );
  body.appendChild(card);

  if (!state.handoff) {
    body.appendChild(el("p", "panel-muted", "The handoff commands haven't been marked as run — this is the shape of the ending, not a claim about your estate."));
  }
  body.appendChild(
    el(
      "p",
      "panel-muted carve-honesty",
      "Deferred to the follow-up: the card doesn't yet SLIDE out of the Terraform box and into the chant project " +
        "beside last month's carves — it is marked in place. The Floci `--live` tier (a real terraform apply, a real " +
        "plan showing no destroy) is the other half of that follow-up.",
    ),
  );
  const again = el("button", "act", "↺ start over");
  again.title = "Back to Advise. Whatever the steps already wrote stays in the demo copy.";
  again.addEventListener("click", actions.reset);
  body.appendChild(again);
}
