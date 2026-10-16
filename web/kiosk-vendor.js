// behold#571: a kiosk page per tool, `/<tool>`, that the tool's maker can
// share without it promoting a competitor (COMPETES). It shows that tool's scenarios
// alone: its name (and its logo where its owner allows one), its runs only,
// and a footer saying who makes it and that they don't endorse the demo.
//
// Live when demo.json's `tool` is this tool, as /kiosk shows it. Otherwise a
// replay of the tool's newest cycle that ran to its reset
// (`cycles/<tool>/latest.json`, which the loop driver publishes), stepped at
// the pace it was recorded, until the tool's scenario starts again.
//
// Pure functions here; kiosk.js draws them.

/**
 * Each tool with a page: its name as its owner writes it, its owner, its
 * official site, its logo when its owner's published rules allow one (else
 * null, the name as text), and the footer's credit. `terms` are the words
 * that name the tool or its owner. `kind` is what it competes as (see
 * COMPETES): an `engine` plans and applies, an `orchestrator` drives an
 * engine. Keep the keys in step with VENDOR_TOOLS in src/terragucci-demo.ts.
 *
 * - Terraform: HashiCorp's rules allow the name as text, with the mark noted.
 * - Terragrunt: Gruntwork publishes logo files, but a logo on a page like
 *   this reads as a partnership, so the name is text.
 * - CDK Terrain: the Open Construct Foundation's continuation of CDKTF; its
 *   site, cdktn.io, publishes no rules for its logo, so the name is text.
 * - choudoufu: ours, logo and all.
 */
export const VENDORS = {
  terraform: {
    name: "Terraform",
    owner: "HashiCorp",
    url: "https://developer.hashicorp.com/terraform",
    logo: null,
    credit: "Terraform is a trademark of HashiCorp. HashiCorp makes Terraform and does not endorse this demo.",
    kind: "engine",
    terms: ["Terraform", "HashiCorp"],
    // The demo's Terraform roots run in OpenTofu's image (terragucci's stack/demo.sh).
    runsWith: ["opentofu"],
  },
  terragrunt: {
    name: "Terragrunt",
    owner: "Gruntwork, Inc.",
    url: "https://terragrunt.com/",
    logo: null,
    credit: "Terragrunt is made by Gruntwork, Inc., who don't endorse this demo.",
    kind: "orchestrator",
    terms: ["Terragrunt", "Gruntwork"],
    runsWith: [],
  },
  "cdk-terrain": {
    name: "CDK Terrain",
    owner: "the Open Construct Foundation",
    url: "https://cdktn.io/",
    logo: null,
    credit: "CDK Terrain is made by the Open Construct Foundation, who don't endorse this demo.",
    kind: "orchestrator",
    terms: ["CDK Terrain", "CDKTN", "Open Construct"],
    runsWith: [],
  },
  choudoufu: {
    name: "choudoufu",
    owner: "Intentius",
    url: "https://intentius.io/choudoufu/",
    logo: { src: "/vendors/choudoufu-64.png", src2x: "/vendors/choudoufu-128.png" },
    credit: "choudoufu is made by Intentius, who also make this demo. It supports AWS and Kubernetes.",
    kind: "engine",
    terms: ["choudoufu"],
    runsWith: [],
  },
};

/** What a tool's scenarios run on, said on its page as the owner's rules allow ("works with OpenTofu"). */
export const RUNS_WITH = {
  opentofu: {
    name: "OpenTofu",
    url: "https://opentofu.org/",
    words: "The pipeline here works with OpenTofu, which runs these roots.",
    kind: "engine",
    terms: ["OpenTofu"],
  },
};

/**
 * Tools with no page yet that a page still must not promote: orchestrators
 * that compete with Terragrunt and CDK Terrain.
 */
export const COMPETITORS = {
  atmos: { kind: "orchestrator", terms: ["Atmos", "Cloud Posse"] },
  terramate: { kind: "orchestrator", terms: ["Terramate"] },
};

/**
 * What competes with what. Engines compete with engines (Terraform, OpenTofu,
 * choudoufu); orchestrators with orchestrators (Terragrunt, CDK Terrain,
 * Atmos, Terramate). An orchestrator runs on an engine, so its page names the
 * engine freely; an engine's page names no other engine, but for the one its
 * scenarios really run with (`runsWith`).
 */
export const COMPETES = { engine: "engine", orchestrator: "orchestrator" };

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** A tool's entry, or null for a tool with no page. */
export function vendorOf(tool) {
  return typeof tool === "string" && own(VENDORS, tool) ? VENDORS[tool] : null;
}

/** The tool the page was served for (`<meta name="kiosk-tool">`, src/terragucci-demo.ts), or null on /kiosk. */
export function pageTool(doc) {
  const m = doc && doc.querySelector ? doc.querySelector('meta[name="kiosk-tool"]') : null;
  const t = m ? m.getAttribute("content") : null;
  return vendorOf(t) ? t : null;
}

/**
 * The words no page for `tool` may show: each competitor's name and maker's,
 * the competitors being the other tools of its kind, less what its scenarios
 * run with. A page for no tool (/kiosk) has none.
 */
export function otherTerms(tool) {
  const v = vendorOf(tool);
  if (!v) return [];
  const rivals = COMPETES[v.kind];
  const out = [];
  for (const [id, x] of [...Object.entries(VENDORS), ...Object.entries(RUNS_WITH), ...Object.entries(COMPETITORS)]) {
    if (id === tool || x.kind !== rivals || v.runsWith.includes(id)) continue;
    out.push(...x.terms);
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `text` names a competitor of `tool` or its maker, as a whole word
 * in any case. A word inside an identifier is no brand: `terraform_data` is a
 * resource type and `demo-terraform-state` a bucket.
 */
export function namesOther(text, tool) {
  if (typeof text !== "string" || !text) return false;
  return otherTerms(tool).some((t) => new RegExp(`(?<![\\w./-])${escapeRe(t)}(?![\\w/-])`, "i").test(text));
}

/**
 * demo.json as a tool's page shows it: no count of the loop's scenarios or
 * place in it (they would hint at the others), and any text the driver wrote
 * that names a competitor left out: the intro, a card row, the title (the
 * scenario's name instead), the step's line, the next action.
 */
export function scrubDemo(demo, tool) {
  if (!demo) return demo;
  const keep = (t) => (namesOther(t, tool) ? null : t);
  const about = demo.about
    ? Object.fromEntries(Object.entries(demo.about).filter(([, t]) => !namesOther(t, tool)))
    : null;
  const name = keep(demo.name);
  return {
    ...demo,
    scenarios: null,
    index: null,
    intro: keep(demo.intro),
    name,
    title: keep(demo.title) ?? name ?? "",
    label: keep(demo.label) ?? "",
    about: about && Object.keys(about).length ? about : null,
    next: demo.next ? { ...demo.next, action: keep(demo.next.action) ?? "the next step" } : null,
  };
}

/**
 * The tool a demo.json write is about. A driver before behold#571 wrote no
 * `tool`, and ran Terraform scenarios only: a scenario the kiosk knows
 * (`known`, kiosk.js SCENARIOS) is Terraform's then.
 */
export function demoTool(demo, known = {}) {
  if (!demo) return null;
  if (typeof demo.tool === "string" && demo.tool) return demo.tool;
  return own(known, demo.scenario) ? "terraform" : null;
}

/** Whether demo.json is live for this tool's page: its scenario is the tool's, and it is no base. */
export function liveFor(demo, tool, known = {}) {
  return !!demo && demo.scenario !== "base" && demoTool(demo, known) === tool;
}

/**
 * Whether a run belongs on the tool's page: a run of its repo. A run with no
 * `repo` is matched by its `tool`; a run with neither comes from a driver
 * before behold#571, which ran Terraform's repo alone.
 */
export function keepRun(run, { tool, repo }) {
  if (!run) return false;
  if (typeof run.repo === "string" && run.repo) return !!repo && run.repo === repo;
  if (typeof run.tool === "string" && run.tool) return run.tool === tool;
  return tool === "terraform";
}

/** The runs index with only the tool's runs; any other answer as it came. */
export function filterIndex(index, which) {
  if (!index || !index.doc || !Array.isArray(index.doc.runs)) return index;
  return { ...index, doc: { ...index.doc, runs: index.doc.runs.filter((r) => keepRun(r, which)) } };
}

/**
 * Whether this behold serves the repo: the reports' project (`<host>/<path>`)
 * ends with the repo's `<owner>/<name>`. The graph frame and the plan's facts
 * are the served repo's, so a page for another repo shows neither.
 */
export function servesRepo(project, repo) {
  if (typeof project !== "string" || typeof repo !== "string" || !project || !repo) return false;
  const p = project.replace(/\.git$/, "").toLowerCase();
  const r = repo.toLowerCase();
  return p === r || p.endsWith(`/${r}`);
}

// ---------------------------------------------------------------------------
// The replay.

/** How long the replay holds its last step (the reset) before it starts again: the driver's hold. */
export const REPLAY_LAST_HOLD_MS = 20_000;

/** How long each step of a cycle was shown, in ms, from the `at` of the next one; the last one the hold. */
export function stepDurations(steps) {
  return steps.map((s, i) => {
    if (i === steps.length - 1) return REPLAY_LAST_HOLD_MS;
    const d = Date.parse(steps[i + 1].at) - Date.parse(s.at);
    return Number.isFinite(d) && d > 0 ? d : 0;
  });
}

/**
 * Where the replay is, `elapsed` ms after it started, looping: the step's
 * index, and the time it stands for (the step's `at` plus the time into it),
 * which the page reads as now while it replays. `{ index, at, loop }`.
 */
export function replayAt(steps, elapsed) {
  const ds = stepDurations(steps);
  const loop = ds.reduce((a, b) => a + b, 0);
  let t = loop > 0 ? ((elapsed % loop) + loop) % loop : 0;
  for (let i = 0; i < steps.length; i++) {
    if (t < ds[i] || i === steps.length - 1) return { index: i, at: new Date(Date.parse(steps[i].at) + Math.min(t, ds[i])), loop };
    t -= ds[i];
  }
  return { index: 0, at: new Date(Date.parse(steps[0].at)), loop };
}

const ms = (v) => (v ? Date.parse(v) : NaN);

/** A job's or step's status at time `t`: queued before it started, running before it ended, then as it ended. */
function statusAt(o, t) {
  if (o.status === "skipped") return { status: "skipped", started_at: o.started_at ?? null, ended_at: o.ended_at ?? null };
  const s = ms(o.started_at);
  const e = ms(o.ended_at);
  if (!Number.isNaN(s) && t < s) return { status: "queued", started_at: null, ended_at: null };
  if (!Number.isNaN(e) && t < e) return { status: "running", started_at: o.started_at, ended_at: null };
  return { status: o.status, started_at: o.started_at ?? null, ended_at: o.ended_at ?? null };
}

/**
 * A run as it stood at time `t` (ms), from the copy made when it ended: each
 * job and step queued before it started and running until it ended, a
 * running step's log cut to the share of its time gone by.
 */
export function runAsOf(run, t) {
  if (!run) return run;
  const out = { ...run, ...statusAt(run, t) };
  if (Array.isArray(run.jobs)) {
    out.jobs = run.jobs.map((j) => {
      const jo = { ...j, ...statusAt(j, t) };
      if (Array.isArray(j.steps)) {
        jo.steps = j.steps.map((st) => {
          const so = { ...st, ...statusAt(st, t) };
          const log = Array.isArray(st.log) ? st.log : [];
          if (so.status === "queued") so.log = [];
          else if (so.status === "running") {
            const a = ms(st.started_at);
            const b = ms(st.ended_at);
            const share = b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 1;
            so.log = log.slice(0, Math.ceil(log.length * share));
          }
          return so;
        });
      }
      return jo;
    });
  }
  return out;
}

/** The replay's runs index at time `t`: the cycle's runs that had been created by then, newest first, as they stood. */
export function replayIndex(runs, t) {
  const shown = runs.filter((r) => {
    const c = ms(r.created_at || r.started_at);
    return Number.isNaN(c) || c <= t;
  });
  return { doc: { schema: "demo.runs/v1", runs: shown.sort((a, b) => b.id - a.id).map((r) => runAsOf(r, t)) } };
}

/** "14:05", a time's hours and minutes in UTC; null for no time. */
export function hhmm(iso) {
  const t = Date.parse(iso || "");
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

const counted = (n) => Number.isInteger(n) && n > 0;

/**
 * About how many minutes until the tool's scenario is live again, from the
 * loop's order and the length of the tool's latest cycle: what is left of
 * the scenario live now, and a cycle's length for each scenario between it
 * and the tool's. Null when the loop's order isn't known (no index, a base,
 * or a loop of another length than the one the cycle ran in).
 */
export function liveEstimate(live, cycle, now = new Date()) {
  if (!live || !cycle || !cycle.steps || !cycle.steps.length) return null;
  const first = cycle.steps[0];
  const n = live.scenarios;
  const i = live.index;
  const j = first.index;
  if (!counted(n) || !counted(i) || !counted(j) || first.scenarios !== n || j > n || i > n) return null;
  const len = ms(cycle.ended) - ms(cycle.started);
  if (!(len > 0)) return null;
  const into = now.getTime() - ms(live.started_at);
  if (Number.isNaN(into)) return null;
  const ahead = (j - i - 1 + n) % n;
  const left = Math.max(0, len - into);
  return Math.max(1, Math.round((left + ahead * len) / 60_000));
}

/** The replay's banner: "Replay of the run at 14:05 UTC · live again in about 6 min", without the estimate when there is none. */
export function replayBanner(cycle, minutes) {
  const at = hhmm(cycle && (cycle.started || (cycle.steps && cycle.steps[0] && cycle.steps[0].at)));
  const head = at ? `Replay of the run at ${at} UTC` : "Replay of the latest run";
  return Number.isInteger(minutes) && minutes > 0 ? `${head} · live again in about ${minutes} min` : head;
}

/** The page's words when the tool's scenario has no cycle yet; with `graph`, they say the graph below is its repo on the base. */
export function notRunWords(vendor, { graph = false } = {}) {
  const text = `The ${vendor.name} scenario shows here once it has run through the demo's pipeline.`;
  return {
    title: "This scenario hasn't run yet",
    text: graph ? `${text} Below, its repo as it stands on the base.` : text,
  };
}

/**
 * The view checkout of a tool's repo, by the names terragucci's demo driver
 * gives the repos: `demo` for Terraform, `demo-<tool>` for the others. Null
 * for a tool with no page.
 */
export function toolCheckout(tool) {
  if (!vendorOf(tool)) return null;
  return tool === "terraform" ? "demo" : `demo-${tool}`;
}

/** behold#571: the checkout a tool's page shows before its first cycle names its repo: the tool's, when this behold serves it (`/api/project`'s viewRepos); null otherwise. */
export function notRunRepo(tool, served) {
  const name = toolCheckout(tool);
  return name && Array.isArray(served) && served.includes(name) ? name : null;
}

/** What a tool calls the thing with its own state: a Terragrunt unit, a root otherwise (behold#571). */
export function rootNoun(tool) {
  return tool === "terragrunt" ? { one: "unit", many: "units" } : { one: "root", many: "roots" };
}

/** The legend's words, without naming a competing engine on an engine's page. */
export function rootWord(tool) {
  if (tool === "terragrunt") return "a Terragrunt unit";
  return namesOther("Terraform", tool) ? "a root" : "a Terraform root";
}

/**
 * A line of text with names in it made links: `[{ text }, { text, url }, …]`,
 * the first time each name appears. Every name a page shows links to its
 * official site.
 */
export function linkSegments(text, links) {
  let out = [{ text }];
  for (const l of links) {
    const i = out.findIndex((x) => !x.url && x.text.includes(l.name));
    if (i < 0) continue;
    const x = out[i].text;
    const at = x.indexOf(l.name);
    const parts = [{ text: x.slice(0, at) }, { text: l.name, url: l.url }, { text: x.slice(at + l.name.length) }].filter((p) => p.text);
    out = [...out.slice(0, i), ...parts, ...out.slice(i + 1)];
  }
  return out;
}

/** The footer's lines on a tool's page: the credit, and what its scenarios run with, each with its names linked. */
export function creditLines(tool) {
  const v = vendorOf(tool);
  if (!v) return [];
  const lines = [linkSegments(v.credit, [{ name: v.name, url: v.url }])];
  for (const id of v.runsWith) {
    const r = RUNS_WITH[id];
    if (r) lines.push(linkSegments(r.words, [{ name: r.name, url: r.url }]));
  }
  return lines;
}
