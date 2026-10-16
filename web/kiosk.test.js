import { describe, expect, it } from "vitest";
import { stepTone, nextProgress, nextSeen, BEAT_CHANGES, INTRO_HEAD, READ_STORE, READ_TITLE, STEP_VIEW, STEP_WORDS, aboutRows, approvalPanel, approveGloss, chantProject, factsLine, focusRoots, holdHead, holdModel, introText, readStored, readingRows, renderReading, scenarioHead, frameSrc, factLines, kioskView, matchingPull, pendingApproval, renderKiosk, renderViewToggle, reportless, runPanel, runPin, stepView, viewZoom } from "./kiosk.js";
import { VENDORS } from "./kiosk-vendor.js";
import { PICK_HOLD_MS } from "./kiosk-runs.js";

const demo = (step, extra = {}) => ({ cycle: 1, scenario: "a-output", title: "t", step, label: "", started_at: "2026-10-15T03:00:00Z", next: null, pull: 7, commit: "abc12345", ...extra });
const answer = {
  roots: ["app", "edge", "network", "other"].map((name) => ({ member: "demo", name, path: name })),
  pull_request: { run: { pull_request: "7", commit: "abc12345" }, roots: ["app", "edge", "network"], reads: [], waves: [], totals: { update: 3 }, totals_roots: 3, blast: { roots: ["app", "edge", "network"], downstream: [] } },
};
const progress = (states, reads = []) => ({ run: { present: true, commit: "abc12345", updated: "2026-10-15T03:05:00Z" }, states, reads });

describe("focusRoots (#569)", () => {
  it("brings the pull request's roots forward while it is planned", () => {
    expect(focusRoots(demo("planned"), answer, null)).toEqual(["app", "edge", "network"]);
  });
  it("brings the wave that waits, applies or failed forward, and nothing once applied", () => {
    const p = progress([
      { number: 1, state: "applied", roots: ["network", "other"], reads: [] },
      { number: 2, state: "waiting", roots: ["app"], reads: [1] },
    ]);
    expect(focusRoots(demo("waiting"), answer, p)).toEqual(["app"]);
    expect(focusRoots(demo("applied"), answer, p)).toBe(null);
    expect(focusRoots(demo("reset"), answer, p)).toBe(null);
  });
  it("brings a failed wave forward with the waves before it that stay applied", () => {
    const p = progress([
      { number: 1, state: "applied", roots: ["network", "other"], reads: [] },
      { number: 2, state: "failed", roots: ["app"], reads: [1] },
      { number: 3, state: "not-started", roots: ["edge"], reads: [2] },
    ]);
    expect(focusRoots(demo("failed"), answer, p)).toEqual(["app", "network", "other"]);
  });
  it("leaves a root its wave plans no change in out (#569 review)", () => {
    const p = progress([{ number: 1, state: "waiting", roots: ["network", "other"], reads: [], digest: "d", totals: { create: 1 }, changed: ["network"] }]);
    expect(focusRoots(demo("waiting"), answer, p)).toEqual(["network"]);
    expect(pendingApproval(demo("waiting", { next: { action: "approve wave-1", at: null } }), p).roots).toEqual(["network"]);
  });
  it("takes every root of a composed run", () => {
    const p = progress([{ number: 1, state: "applying", roots: ["network"], reads: [], composed: { roots: ["network", "app", "edge"] } }]);
    expect(focusRoots(demo("applying"), answer, p)).toEqual(["network", "app", "edge"]);
  });
});

describe("the hold panel (behold#571)", () => {
  it("heads the panel with its wave, its run and its plan, else what its note is about", () => {
    expect(holdHead({ wave: 2, run: 3605, digest: "jcs1-sha256:02812a1b9999" })).toBe("Wave 2 · run #3605 · plan 02812a1b");
    expect(holdHead({ wave: 3 })).toBe("Wave 3");
    expect(holdHead({ pull: 7 })).toBe("Pull request #7");
    expect(holdHead({ commit: "abc12345ffff" })).toBe("Merge abc12345");
    expect(holdHead({})).toBe(null);
  });
  it("holds how the hold ends, else the driver's approval, else the run's note, and nothing past that", () => {
    const model = { wave: 2, digest: "sha256:02812a1b", run: 3605, rows: [] };
    expect(holdModel({ approval: model }, demo("waiting"))).toMatchObject({ kind: "approval", wave: 2, head: "Wave 2 · run #3605 · plan 02812a1b" });
    const p = progress([{ number: 2, state: "waiting", roots: ["app"], reads: [], digest: "jcs1-sha256:0accc105ba06" }]);
    expect(holdModel({ progress: p }, demo("waiting", { next: { action: "approve wave-2", at: null } }))).toMatchObject({ kind: "driver", wave: 2, head: "Wave 2 · plan 0accc105" });
    expect(holdModel({ answer: null, progress: null }, demo("planned", { pull: 989 }))).toEqual({ kind: "note", wave: null, head: "Pull request #989", lines: [{ cls: "k-note", text: "The pipeline is planning pull request #989." }] });
    expect(holdModel({ noReports: true }, demo("planned"))).toBe(null);
    expect(holdModel({ answer, progress: null }, demo("planned"))).toBe(null);
  });
});

describe("frameSrc (#569)", () => {
  it("frames behold's own view, bare, told its host", () => {
    expect(frameSrc("http://localhost:4700")).toBe("/?embed=1&bare=1&zoom=resources&host=http%3A%2F%2Flocalhost%3A4700");
  });
});

describe("factLines (#569)", () => {
  it("says the pull request's totals and blast radius", () => {
    expect(factLines(demo("planned"), answer)).toEqual(["pull request #7 changes across 3 roots: 3 update", "blast radius: app, edge, network", "unchanged: other"]);
    // behold#571: the lead block shows them as one line.
    expect(factsLine(demo("planned"), answer)).toBe("pull request #7 changes across 3 roots: 3 update · blast radius: app, edge, network · unchanged: other");
    expect(factLines(demo("planned"), answer, "terragrunt")[0]).toBe("pull request #7 changes across 3 units: 3 update");
  });
});

describe("runPin: the frame stays on the cycle's run (#569)", () => {
  it("draws the pull request's plan, then the cycle's commit up to applied, then the base", () => {
    expect(runPin(demo("pull-request"))).toBe("pull-7-abc12345");
    expect(runPin(demo("planned"))).toBe("pull-7-abc12345");
    expect(runPin(demo("pull-request", { commit: null }))).toBe("pull-7");
    expect(runPin(demo("pull-request", { pull: null, commit: null }))).toBe("pull");
    for (const step of ["merged", "applying", "waiting", "approved", "failed", "resumed", "applied"]) expect(runPin(demo(step))).toBe("abc12345");
    expect(runPin(demo("reset"))).toBe("base");
    expect(runPin(demo("applied", { scenario: "base" }))).toBe("base");
    expect(runPin(demo("stalled", { commit: null }))).toBe("none");
    expect(runPin(null)).toBe(null);
  });
});

describe("before the merge, no other cycle's plan (#569)", () => {
  // Cycle 441's narration at pull-request 989, while the reports' newest plan is cycle 439's pull request 987.
  const older = { ...answer, pull_request: { ...answer.pull_request, run: { pull_request: "987", commit: "365a4f0d" } } };
  const sameNumberOtherCommit = { ...answer, pull_request: { ...answer.pull_request, run: { pull_request: "989", commit: "0badc0de" } } };
  const ours = { ...answer, pull_request: { ...answer.pull_request, run: { pull_request: "989", commit: "659dee43" } } };
  const now = (step) => demo(step, { pull: 989, commit: "659dee43" });
  it("pins the frame to this cycle's pull request and commit at pull-request and planned", () => {
    for (const step of ["pull-request", "planned"]) {
      expect(runPin(now(step))).toBe("pull-989-659dee43");
      expect(matchingPull(older, now(step))).toBe(null);
      expect(matchingPull(sameNumberOtherCommit, now(step))).toBe(null);
      expect(matchingPull(ours, now(step))).toBe(ours.pull_request);
      expect(focusRoots(now(step), older, null)).toBe(null);
      expect(factLines(now(step), older)).toEqual([]);
      expect(runPanel(now(step), older, null).note).toBe("The pipeline is planning pull request #989.");
    }
  });
  it("from the merge on, takes the plan by its number: demo.json's commit is the merge's", () => {
    expect(matchingPull(ours, demo("merged", { pull: 989, commit: "53c1e5d2" }))).toBe(ours.pull_request);
    expect(matchingPull(older, demo("merged", { pull: 989, commit: "53c1e5d2" }))).toBe(null);
  });
});

describe("the scenario's card under the title (behold#571)", () => {
  const about = { changes: "Network's port goes from 8080 to 9090.", watch: "Wave 2 fails partway.", shows: "Nothing here is atomic." };

  it("has three rows in order, labelled as the kiosk draws them", () => {
    expect(aboutRows(demo("failed", { about }))).toEqual([
      { label: "What changes", text: about.changes },
      { label: "Watch for", text: about.watch },
      { label: "Shows", text: about.shows },
    ]);
  });

  it("has no rows when demo.json has no card", () => {
    expect(aboutRows(demo("reset", { scenario: "base", about: null }))).toEqual([]);
    expect(aboutRows(demo("reset"))).toEqual([]);
  });

  // A DOM just big enough for renderKiosk: elements with a class, text and children.
  const fakeDocument = () => {
    const make = (tag) => {
      const n = { tagName: tag, className: "", textContent: "", children: [] };
      n.appendChild = (c) => (n.children.push(c), c);
      n.append = (...cs) => cs.forEach((c) => n.children.push(typeof c === "string" ? { tagName: "#text", textContent: c, children: [] } : c));
      n.replaceChildren = () => (n.children = []);
      return n;
    };
    return { createElement: make };
  };
  const find = (n, cls) => (n.className.split(" ").includes(cls) ? [n] : []).concat(...(n.children || []).map((c) => (c.className !== undefined ? find(c, cls) : [])));

  it("draws the card right under the title, and none without about", () => {
    const was = globalThis.document;
    globalThis.document = fakeDocument();
    try {
      const bar = document.createElement("header");
      const s = { demo: { source: "fx", read: "2026-10-15T03:00:00Z", demo: demo("failed", { scenario: "failure", about }) }, answer: null, progress: null };
      renderKiosk(bar, s, new Date("2026-10-15T03:01:00Z"));
      const left = find(bar, "k-lead")[0];
      // behold#571: the lead block, a grid of labelled rows: the title (over it, the tool, the kicker and the
      // progress), then what changes, the step, next, watch for, shows and the facts; each row a fixed box.
      expect(left.children.map((c) => c.className)).toEqual([
        "k-box k-box-title", "k-row k-row-beat", "k-row k-row-step k-step-failed", "k-row k-row-next", "k-row k-row-more", "k-row k-row-more", "k-row k-row-facts k-row-empty",
      ]);
      expect(left.children.map((c) => c.children.map((x) => x.className.split(" ")[0]))).toEqual([["k-overline", "k-title"], ["k-row-label", "k-box"], ["k-row-label", "k-box"], ["k-row-label", "k-box", "k-nbar"], ["k-row-label", "k-box"], ["k-row-label", "k-box"], []]);
      // The next row's bar is placed by CSS, in the step's tone; a stalled driver's next has none.
      const nbar = find(bar, "k-nbar")[0];
      expect(nbar.className).toBe("k-nbar k-nbar-none");
      // Each row: its label in the fixed column, its words in the box beside it.
      const rowsOf = (cls) => find(bar, cls).map((r) => [r.children[0].textContent, r.children[1].children[0].className, r.children[1].children[0].textContent]);
      expect(rowsOf("k-row-beat")).toEqual([[BEAT_CHANGES, "k-beat", about.changes]]);
      expect(rowsOf("k-row-step")[0].slice(0, 2)).toEqual([STEP_WORDS.failed, "k-step"]);
      expect(rowsOf("k-row-more")).toEqual([["Watch for", "k-about", about.watch], ["Shows", "k-about", about.shows]]);
      expect(find(bar, "k-row-next")[0].children[0].textContent).toBe("Next");
      // The scenario's progress sits on the quiet line over the title, at its end.
      const over = find(bar, "k-overline")[0];
      expect(over.children.map((c) => c.className)).toEqual(["k-kicker", "k-strip"]);
      expect(find(bar, "k-stop").map((c) => c.textContent)).toEqual(["pull request", "planned", "merged", "waves", "applied", "reset"]);

      s.demo.demo = demo("reset", { scenario: "base", about: null });
      renderKiosk(bar, s, new Date("2026-10-15T03:01:00Z"));
      expect(find(bar, "k-about")).toEqual([]);
      expect(find(bar, "k-beat")).toEqual([]);
      // Render what's present: the rows with nothing in them keep their place and draw nothing.
      expect(find(bar, "k-row-empty").map((c) => c.className)).toEqual(["k-row k-row-beat k-row-empty", "k-row k-row-more k-row-empty", "k-row k-row-more k-row-empty", "k-row k-row-facts k-row-empty"]);
      // On the base, the hold panel holds the run's note, quiet, with no wave to light.
      expect(find(bar, "k-box-hold")[0].className).toBe("k-box k-box-hold k-hold");

      // behold#571: no intro band at a live step; between scenarios the intro takes the card's box.
      const intro = "Terraform keeps what it built in a state file.";
      s.demo.demo = demo("waiting", { scenario: "failure", about, intro });
      renderKiosk(bar, s, new Date("2026-10-15T03:01:00Z"));
      expect(find(bar, "k-intro")).toEqual([]);
      expect(find(bar, "k-beat")).toHaveLength(1);
      s.demo.demo = demo("reset", { scenario: "failure", about, intro });
      renderKiosk(bar, s, new Date("2026-10-15T03:01:00Z"));
      const shown = find(bar, "k-intro");
      expect(shown).toHaveLength(1);
      expect(shown[0].textContent).toBe(intro);
      expect(find(bar, "k-row-beat")[0].children[0].textContent).toBe(INTRO_HEAD);
      expect(find(bar, "k-about")).toEqual([]);
    } finally {
      globalThis.document = was;
    }
  });
});

describe("the approval panel's drawing (behold#571)", () => {
  // A DOM with what the panel's chip needs: attributes, data and a click.
  const panelDocument = () => ({
    createElement: (tag) => {
      const n = { tagName: tag, className: "", textContent: "", children: [], attrs: {}, dataset: {}, listeners: {} };
      n.appendChild = (c) => (n.children.push(c), c);
      n.append = (...cs) => cs.forEach((c) => n.children.push(typeof c === "string" ? { tagName: "#text", textContent: c, children: [] } : c));
      n.setAttribute = (k, v) => (n.attrs[k] = v);
      n.addEventListener = (k, f) => (n.listeners[k] = f);
      return n;
    },
  });
  const find = (n, cls) => ((n.className || "").split(" ").includes(cls) ? [n] : []).concat(...(n.children || []).map((c) => find(c, cls)));

  it("draws four rows, lit as the model says, and a chip that shows its log line", () => {
    const was = globalThis.document;
    globalThis.document = panelDocument();
    try {
      const a = { id: "T11", product: "terragucci", feature: "Waiting for approval", note: "The wave stops here.", docs: { product: "terragucci", path: "/guides/approve-a-wave/" } };
      const line = { run: 444, job: "apply-wave-2", step: 2, n: 13, a };
      const shown = [];
      const model = {
        wave: 2,
        digest: "jcs1-sha256:0accc105ba060b9974468c91def518039d935ad6629f8a15869f6e89ef748b61",
        rows: [
          { id: "requested", label: "Requested", state: "lit", text: "Wave 2 asked for an approval of this plan.", at: "2026-10-15T04:09:41Z", commit: "57869649aaaa", line },
          { id: "approved", label: "Approved", state: "dim", text: "Next the driver signs.", command: "chant approve tf-apply wave-2" },
          { id: "resumed", label: "Resumed", state: "dim", text: "Then the waves run again." },
          { id: "spent", label: "Spent", state: "dim", text: "Then the approval is used up." },
        ],
      };
      const panel = approvalPanel(model, { showLine: (l) => shown.push(l) });
      // behold#571: the wave, the run and the plan head the hold panel; the panel's own head says what its rows are.
      expect(find(panel, "k-ap-head")[0].textContent).toBe("Approval · times in UTC");
      expect(holdHead({ wave: model.wave, run: 3605, digest: model.digest })).toBe("Wave 2 · run #3605 · plan 0accc105");
      expect(find(panel, "k-ap-row").map((r) => r.className)).toEqual(["k-ap-row k-ap-lit", "k-ap-row k-ap-dim", "k-ap-row k-ap-dim", "k-ap-row k-ap-dim"]);
      expect(find(panel, "k-ap-facts")[0].textContent).toBe("04:09:41 · ledger 57869649");
      expect(find(panel, "k-command")[0].textContent).toBe("chant approve tf-apply wave-2");
      const chip = find(panel, "r-ann")[0];
      expect(chip.textContent).toBe("terragucci · Waiting for approval");
      chip.listeners.click();
      expect(shown).toEqual([line]);
    } finally {
      globalThis.document = was;
    }
  });
});

describe("which view the frame shows (#571)", () => {
  it("shows the components at every step, the pull request's planned waves included", () => {
    for (const step of ["pull-request", "planned", "merged", "applying", "waiting", "approved", "failed", "resumed", "applied", "reset"]) expect(stepView(step)).toBe("components");
    expect(Object.keys(STEP_VIEW).sort()).toEqual(Object.keys(STEP_WORDS).sort());
  });

  it("follows the step, and only the resources when the repo offers no components zoom", () => {
    expect(kioskView(demo("planned"), { components: true })).toEqual({ view: "components", pinned: false, secs: null });
    expect(kioskView(demo("planned"), { components: true, pick: { view: "resources", at: 0 }, now: 1000 }).view).toBe("resources");
    expect(kioskView(demo("waiting"), { components: true })).toEqual({ view: "components", pinned: false, secs: null });
    expect(kioskView(demo("waiting"), { components: false })).toEqual({ view: "resources", pinned: false, secs: null });
    expect(kioskView(demo("waiting"), { components: false, pick: { view: "components", at: 0 }, now: 1000 }).view).toBe("resources");
    expect(kioskView(null, { components: true }).view).toBe("components");
    expect(kioskView(null, { components: false }).view).toBe("resources");
  });

  it("holds a clicked view for 90 s after the last click, then follows the step again", () => {
    const pick = { view: "resources", at: 1_000_000 };
    expect(PICK_HOLD_MS).toBe(90_000);
    expect(kioskView(demo("applying"), { components: true, pick, now: 1_000_000 })).toEqual({ view: "resources", pinned: true, secs: 90 });
    expect(kioskView(demo("applying"), { components: true, pick, now: 1_000_000 + 89_500 })).toEqual({ view: "resources", pinned: true, secs: 1 });
    expect(kioskView(demo("applying"), { components: true, pick, now: 1_000_000 + 90_000 })).toEqual({ view: "components", pinned: false, secs: null });
    // A pick of a view the toggle doesn't offer holds nothing.
    expect(kioskView(demo("applying"), { components: true, pick: { view: "logical", at: 1_000_000 }, now: 1_000_000 }).view).toBe("components");
  });

  it("opens the frame on a view's zoom", () => {
    expect(frameSrc("https://demo.example")).toContain("zoom=resources");
    expect(frameSrc("https://demo.example", viewZoom("components"))).toContain("zoom=components");
    // behold#571: the kiosk's theme goes to the frame with the repo.
    expect(frameSrc("https://demo.example", "components", "demo", "Dawnfox")).toContain("theme=Dawnfox");
    expect(frameSrc("https://demo.example", "components", null, null)).not.toContain("theme=");
    expect(viewZoom("resources")).toBe("resources");
    expect(viewZoom("nonsense")).toBe("resources");
  });

  it("says how to read the view shown, a row per mark", () => {
    const words = (v, t) => readingRows(v, t).map((r) => r.words).join(" ");
    expect(readingRows("components").map((r) => r.mark)).toEqual(["card", "box", "solid", "dashed", "order", "marks"]);
    expect(readingRows("resources").map((r) => r.mark)).toEqual(["box", "card", "solid", "dashed", "marks"]);
    expect(readingRows("components")[0].words).toBe("Card: a Terraform root with its own state.");
    expect(readingRows("components")[1].words).toBe("Box: a wave, titled with the job that applies it.");
    expect(readingRows("resources")[0].words).toBe("Box: a Terraform root with its own state.");
    expect(words("components")).toMatch(/Solid arrow: a read of applied outputs\. Dashed arrow: planned values, before they apply\./);
    expect(words("components")).toMatch(/Marks: the forge and the tools a job runs/);
    // Short items, so two to a line keep the open frame a few lines tall.
    for (const v of ["components", "resources"]) for (const r of readingRows(v, "terragrunt")) expect(r.words.length, r.words).toBeLessThanOrEqual(50);
    // behold#571: a Terragrunt scenario names its units.
    for (const v of ["components", "resources"]) {
      const w = words(v, "terragrunt");
      expect(w).toMatch(/a Terragrunt unit with its own state/);
      expect(w).not.toMatch(/\broots?\b/);
    }
    expect(words("components", "terragrunt")).toMatch(/Waves apply in order, units in a wave together/);
    // A tool whose pipeline writes no reports: behold's own components graph, with no jobs or planned values in it.
    expect(readingRows("components", "chant")).toEqual([
      { mark: "card", words: "Card: a Terraform root with its own state." },
      { mark: "box", words: "Box: a wave of components that apply together." },
      { mark: "solid", words: "Arrow: a component reading another's outputs." },
    ]);
    expect(readingRows("resources", "chant")).toEqual([{ mark: "box", words: "Box: a Terraform root with its own state." }]);
  });

  it("draws 'How to read this' as a header that folds the rows, and keeps the viewer's fold", () => {
    const was = globalThis.document;
    globalThis.document = { createElement: (tag) => {
      const n = { tagName: tag, className: "", textContent: "", children: [], attrs: {}, listeners: {} };
      n.appendChild = (c) => (n.children.push(c), c);
      n.append = (...cs) => cs.forEach((c) => n.children.push(c));
      n.replaceChildren = () => (n.children = []);
      n.setAttribute = (k, v) => (n.attrs[k] = v);
      n.addEventListener = (k, f) => (n.listeners[k] = f);
      return n;
    } };
    try {
      const host = document.createElement("section");
      const toggled = [];
      renderReading(host, "components", null, { open: true, onToggle: (o) => toggled.push(o) });
      expect(host.hidden).toBe(false);
      expect(host.children.map((c) => c.className)).toEqual(["k-read-head", "k-read-rows"]);
      expect(host.children[0].textContent).toBe(READ_TITLE);
      expect(host.children[1].children.map((li) => li.children[0].className)).toEqual(["k-read-mark k-read-card", "k-read-mark k-read-box", "k-read-mark k-read-solid", "k-read-mark k-read-dashed", "k-read-mark k-read-order", "k-read-mark k-read-marks"]);
      host.children[0].listeners.click();
      expect(toggled).toEqual([false]);
      // Folded, the header stays as its one line.
      renderReading(host, "components", null, { open: false });
      expect(host.children.map((c) => c.className)).toEqual(["k-read-head"]);
      expect(host.children[0].attrs["aria-expanded"]).toBe("false");
    } finally {
      globalThis.document = was;
    }
    const store = (v) => ({ getItem: (k) => (k === READ_STORE ? v : null) });
    expect(readStored(store("open"))).toBe(true);
    expect(readStored(store("closed"))).toBe(false);
    expect(readStored(store(null))).toBe(null);
    expect(readStored({ getItem: () => { throw new Error("blocked"); } })).toBe(null);
    expect(readStored(null)).toBe(null);
  });

  it("knows a tool whose pipeline writes no terragucci reports, and a chant project behold draws itself", () => {
    expect(Object.entries(VENDORS).filter(([, v]) => reportless(v)).map(([id]) => id)).toEqual(["chant"]);
    expect(reportless(null)).toBe(false);
    expect(chantProject({ memberKinds: ["chant"] })).toBe(true);
    expect(chantProject({ memberKinds: ["terraform"] })).toBe(false);
    expect(chantProject({ error: "nope" })).toBe(false);
  });

  // A DOM for the toggle: elements with attributes and click listeners.
  const toggleDocument = () => ({
    createElement: (tag) => {
      const n = { tagName: tag, className: "", textContent: "", children: [], attrs: {}, hidden: false, listeners: {} };
      n.appendChild = (c) => (n.children.push(c), c);
      n.replaceChildren = () => (n.children = []);
      n.setAttribute = (k, v) => (n.attrs[k] = v);
      n.addEventListener = (k, f) => (n.listeners[k] = f);
      return n;
    },
  });

  it("draws the toggle with the view shown pressed, says what leads, and hides without a components zoom", () => {
    const was = globalThis.document;
    globalThis.document = toggleDocument();
    try {
      const host = document.createElement("div");
      const picked = [];
      renderViewToggle(host, { view: "components", pinned: false, secs: null }, { components: true, onPick: (v) => picked.push(v) });
      expect(host.hidden).toBe(false);
      const buttons = host.children[0].children;
      expect(buttons.map((b) => [b.textContent, b.attrs["aria-pressed"]])).toEqual([["Resources", "false"], ["Components", "true"]]);
      expect(host.children[1].textContent).toBe("the pipeline's jobs and waves · follows the step");
      expect(buttons[1].attrs.title).toBe("the pipeline's jobs and waves");
      buttons[0].listeners.click();
      expect(picked).toEqual(["resources"]);

      renderViewToggle(host, { view: "resources", pinned: true, secs: 42 }, { components: true });
      expect(host.children[1].textContent).toBe("each resource the change touches · held by a click; the step leads again in 42 s");

      renderViewToggle(host, { view: "resources", pinned: false, secs: null }, { components: false });
      expect(host.hidden).toBe(true);
      expect(host.children).toEqual([]);
    } finally {
      globalThis.document = was;
    }
  });
});

describe("the kiosk for a viewer new to the demo (behold#571)", () => {
  const intro = "One change can touch many Terraform states; this demo shows how terragucci applies them in order.";
  const fakeDocument = () => {
    const make = (tag) => {
      const n = { tagName: tag, className: "", textContent: "", children: [] };
      n.appendChild = (c) => (n.children.push(c), c);
      n.append = (...cs) => cs.forEach((c) => n.children.push(typeof c === "string" ? { tagName: "#text", textContent: c, children: [] } : c));
      n.replaceChildren = () => (n.children = []);
      return n;
    };
    return { createElement: make };
  };
  const find = (n, cls) => (n.className.split(" ").includes(cls) ? [n] : []).concat(...(n.children || []).map((c) => (c.className !== undefined ? find(c, cls) : [])));
  const draw = (d) => {
    const was = globalThis.document;
    globalThis.document = fakeDocument();
    try {
      const bar = document.createElement("header");
      const foot = document.createElement("footer");
      renderKiosk(bar, { demo: { source: "s3://demo-reports/demo", read: "2026-10-15T03:00:00Z", demo: d }, answer: null, progress: null }, new Date("2026-10-15T03:01:00Z"), foot);
      return { bar, foot };
    } finally {
      globalThis.document = was;
    }
  };

  it("shows the intro in the card's box between scenarios, never as a band, and none without one", () => {
    // behold#571: a live step has no intro band; "What is this?" holds it.
    expect(find(draw(demo("planned", { intro })).bar, "k-intro")).toEqual([]);
    const { bar } = draw(demo("reset", { intro }));
    const shown = find(bar, "k-intro");
    expect(shown).toHaveLength(1);
    // behold#571: the intro's head is its row's label, its words the row's.
    expect([find(bar, "k-row-beat")[0].children[0].textContent, shown[0].textContent]).toEqual([INTRO_HEAD, intro]);
    expect(find(draw(demo("reset")).bar, "k-intro")).toEqual([]);
    expect(find(draw(demo("planned", { intro: null })).bar, "k-intro")).toEqual([]);
    expect(introText(demo("planned", { intro: "   " }))).toBe(null);
  });

  it("says which scenario of how many, with the title and no short label", () => {
    expect(scenarioHead(demo("planned", { index: 2, scenarios: 5, title: "The same change, read once it is built" }))).toEqual({ kicker: "Scenario 2 of 5", title: "The same change, read once it is built" });
    const { bar } = draw(demo("planned", { index: 2, scenarios: 5, title: "The same change, read once it is built" }));
    expect(find(bar, "k-kicker")[0].textContent).toBe("Scenario 2 of 5");
    expect(find(bar, "k-title-text")[0].textContent).toBe("The same change, read once it is built");
  });

  it("leaves the count out when scenarios is missing, 0 or less than the index", () => {
    expect(scenarioHead(demo("planned", { index: 2, title: "t" })).kicker).toBe("Scenario 2");
    expect(scenarioHead(demo("planned", { index: 2, scenarios: 0, title: "t" })).kicker).toBe("Scenario 2");
    expect(scenarioHead(demo("planned", { index: 6, scenarios: 5, title: "t" })).kicker).toBe("Scenario 6");
  });

  it("falls back to the short label without an index, demo.json's name before the table's", () => {
    expect(scenarioHead(demo("planned", { title: "t" }))).toEqual({ kicker: "scenario 2 · A, read through .output", title: "t" });
    expect(scenarioHead(demo("planned", { index: 0, scenarios: 5 })).kicker).toBe("scenario 2 · A, read through .output");
    expect(scenarioHead(demo("planned", { index: null, scenarios: 0, name: "the same change, read late" })).kicker).toBe("scenario 2 · the same change, read late");
    expect(scenarioHead(demo("reset", { scenario: "base", title: "The base", index: null, scenarios: 0, name: null }))).toEqual({ kicker: "The base", title: "The base" });
    expect(scenarioHead(demo("planned", { scenario: "new-one", title: "A new one" }))).toEqual({ kicker: "scenario new-one", title: "A new one" });
  });

  it("has no line on where the narration was read from", () => {
    const { foot } = draw(demo("planned", { intro }));
    expect(JSON.stringify(foot)).not.toMatch(/narration read|s3:\/\/|nothing here writes/);
  });

  it("says who the driver is before the command it runs", () => {
    expect(approveGloss({ wave: 2, roots: ["app"], digest: "jcs1-sha256:0accc105ba06" })).toBe("The driver plays a reviewer who had no hand in the change, and approves wave 2 (app) with that reviewer's own signing key.");
    expect(approveGloss({ wave: 3, roots: [], digest: null })).toBe("The driver plays a reviewer who had no hand in the change, and approves wave 3 with that reviewer's own signing key.");
    const p = progress([{ number: 2, state: "waiting", roots: ["app"], reads: [], digest: "jcs1-sha256:0accc105ba06" }]);
    const was = globalThis.document;
    globalThis.document = fakeDocument();
    try {
      const bar = document.createElement("header");
      renderKiosk(bar, { demo: { source: "fx", read: "2026-10-15T03:00:00Z", demo: demo("waiting", { next: { action: "approve wave-2", at: null } }) }, answer: null, progress: p }, new Date("2026-10-15T03:01:00Z"));
      const card = find(bar, "k-approve")[0];
      expect(card.children.map((c) => c.className)).toEqual(["k-approve-gloss", "k-command", "k-approve-then"]);
      expect(card.children[1].textContent).toBe("chant approve tf-apply wave-2 --actor <reviewer> --sign <reviewer key>");
      // behold#571: the hold panel is headed with its wave and plan, and lit as its wave's job row is.
      const hold = find(bar, "k-box-hold")[0];
      expect(hold.className).toBe("k-box k-box-hold k-hold k-hold-wave");
      expect(hold.children[0].textContent).toBe("Wave 2 · plan 0accc105");
    } finally {
      globalThis.document = was;
    }
  });
});

describe("the lead block's step rail (behold#571)", () => {
  it("takes the step's state: held amber, failed, applied, the accent while it moves, neutral at the reset", () => {
    expect(["waiting", "failed", "stalled", "applied", "applying", "planned", "resumed", "reset"].map(stepTone)).toEqual(["wait", "bad", "bad", "ok", "busy", "busy", "busy", "idle"]);
  });
});

describe("kiosk: the strip in a scenario's own order (behold#571, #631)", async () => {
  const { stripFromSteps, stripStops, STRIP } = await import("./kiosk.js");
  it("puts chant's approval between planned and merged, and lights it while the plan waits", () => {
    const chant = stripFromSteps(["pull-request", "planned", "waiting", "approved", "merged", "applying", "applied", "reset"]);
    expect(chant.map((x) => x.words)).toEqual(["pull request", "planned", "approval", "merged", "waves", "applied", "reset"]);
    expect(stripStops("waiting", chant).find((x) => x.state === "current").words).toBe("approval");
    expect(stripStops("applying", chant).find((x) => x.state === "current").words).toBe("waves");
  });
  it("keeps terragucci's waves, a hold after the merge part of them, and the default strip without steps", () => {
    const tg = stripFromSteps(["pull-request", "planned", "merged", "applying", "failed", "resumed", "waiting", "approved", "resumed", "applied", "reset"]);
    expect(tg.map((x) => x.id)).toEqual(STRIP.map((x) => x.id));
    expect(stripStops("waiting", tg).find((x) => x.state === "current").words).toBe("waves");
    expect(stripFromSteps([])).toBeNull();
    // A run that applied in one go (no wait at all) still shows its waves stop.
    expect(stripFromSteps(["pull-request", "planned", "merged", "applying", "applied", "reset"]).map((x) => x.id)).toEqual(STRIP.map((x) => x.id));
  });
});

// behold#571: the bar under "next, by the driver".
describe("nextProgress and nextSeen", () => {
  const at = "2026-10-16T22:34:35Z";
  const t = (iso) => new Date(iso);
  const ms = (iso) => Date.parse(iso);

  it("fills from next.from to next.at", () => {
    const next = { action: "approve wave-2", from: "2026-10-16T22:34:15Z", at };
    expect(nextProgress(next, t("2026-10-16T22:34:15Z"))).toEqual({ kind: "fill", fraction: 0 });
    expect(nextProgress(next, t("2026-10-16T22:34:20Z"))).toEqual({ kind: "fill", fraction: 0.25 });
    expect(nextProgress(next, t("2026-10-16T22:34:30Z"))).toEqual({ kind: "fill", fraction: 0.75 });
    // A clock a little behind the driver's never draws below empty.
    expect(nextProgress(next, t("2026-10-16T22:34:10Z")).fraction).toBe(0);
    // from wins over when the page saw it.
    expect(nextProgress(next, t("2026-10-16T22:34:30Z"), ms("2026-10-16T22:34:25Z")).fraction).toBe(0.75);
  });

  it("is due at and past the deadline, whatever from says", () => {
    expect(nextProgress({ action: "x", from: "2026-10-16T22:34:15Z", at }, t(at))).toEqual({ kind: "due", fraction: 1 });
    expect(nextProgress({ action: "x", at }, t("2026-10-16T22:40:00Z"))).toEqual({ kind: "due", fraction: 1 });
  });

  it("fills from when the page first saw the deadline when from is missing, and draws no bar when it joined midway", () => {
    const next = { action: "approve wave-2", at };
    expect(nextProgress(next, t("2026-10-16T22:34:25Z"), ms("2026-10-16T22:34:15Z"))).toEqual({ kind: "fill", fraction: 0.5 });
    expect(nextProgress(next, t("2026-10-16T22:34:25Z"), null)).toEqual({ kind: "none", fraction: null });
    // A from that cannot be read falls back the same way.
    expect(nextProgress({ ...next, from: "soon" }, t("2026-10-16T22:34:25Z"), ms("2026-10-16T22:34:15Z")).fraction).toBe(0.5);
    expect(nextProgress({ ...next, from: "2026-10-16T22:34:35Z" }, t("2026-10-16T22:34:25Z"))).toEqual({ kind: "none", fraction: null });
  });

  it("shimmers with no deadline, and draws nothing when there is no next", () => {
    expect(nextProgress({ action: "follow the waves", from: "2026-10-16T22:34:15Z", at: null }, t(at))).toEqual({ kind: "wait", fraction: null });
    expect(nextProgress(null, t(at))).toEqual({ kind: "none", fraction: null });
    expect(nextProgress({ action: "x", at: "not a time" }, t(at))).toEqual({ kind: "none", fraction: null });
  });

  it("remembers when the page first saw each deadline: midway for the one on screen at load or after a mode change", () => {
    const a = { action: "approve wave-2", at };
    const b = { action: "merge pull request 41", at: "2026-10-16T22:35:40Z" };
    let m = nextSeen(undefined, a, "live", 1000);
    expect(m.seen).toBeNull();
    expect(nextSeen(m, a, "live", 2000)).toBe(m);
    m = nextSeen(m, { action: "follow the waves", at: null }, "live", 3000);
    expect(m.seen).toBeNull();
    m = nextSeen(m, b, "live", 4000);
    expect(m.seen).toBe(4000);
    expect(nextSeen(m, b, "live", 5000).seen).toBe(4000);
    expect(nextSeen(m, b, "replay", 5000).seen).toBeNull();
    // Until demo.json is read (undefined), the page has watched nothing: the first deadline it reads was joined midway.
    expect(nextSeen(nextSeen(undefined, undefined, "live", 0), a, "live", 6000).seen).toBeNull();
    // Once read, a deadline that comes after a step with none is seen to begin.
    expect(nextSeen(nextSeen(undefined, null, "live", 0), a, "live", 6000).seen).toBe(6000);
  });
});
