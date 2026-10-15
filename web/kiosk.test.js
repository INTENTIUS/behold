import { describe, expect, it } from "vitest";
import { INTRO_HEAD, STEP_VIEW, STEP_WORDS, aboutRows, approvalPanel, approveGloss, focusRoots, introText, scenarioHead, frameSrc, factLines, kioskView, legendWords, matchingPull, pendingApproval, renderKiosk, renderViewToggle, runPanel, runPin, stepView, viewZoom } from "./kiosk.js";
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

describe("frameSrc (#569)", () => {
  it("frames behold's own view, bare, told its host", () => {
    expect(frameSrc("http://localhost:4700")).toBe("/?embed=1&bare=1&zoom=resources&host=http%3A%2F%2Flocalhost%3A4700");
  });
});

describe("factLines (#569)", () => {
  it("says the pull request's totals and blast radius", () => {
    expect(factLines(demo("planned"), answer)).toEqual(["pull request #7 changes across 3 roots: 3 update", "blast radius: app, edge, network", "not touched: other"]);
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
      expect(runPanel(now(step), older, null).note).toBe("The plan of pull request #989 isn't in the reports yet: the pipeline is planning it.");
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
      const left = find(bar, "k-left")[0];
      // behold#571: the title, the card and the step, each in its own fixed box.
      expect(left.children.map((c) => c.className.split(" ")[0])).toEqual(["k-box", "k-box", "k-box"]);
      expect(left.children.map((c) => c.children.map((x) => x.className.split(" ")[0]))).toEqual([["k-title"], ["k-about"], ["k-step"]]);
      const card = find(bar, "k-about")[0];
      expect(card.tagName).toBe("dl");
      expect(card.children.map((c) => [c.tagName, c.textContent])).toEqual([
        ["dt", "What changes"], ["dd", about.changes],
        ["dt", "Watch for"], ["dd", about.watch],
        ["dt", "Shows"], ["dd", about.shows],
      ]);

      s.demo.demo = demo("reset", { scenario: "base", about: null });
      renderKiosk(bar, s, new Date("2026-10-15T03:01:00Z"));
      expect(find(bar, "k-about")).toEqual([]);

      // behold#571: no intro band at a live step; between scenarios the intro takes the card's box.
      const intro = "Terraform keeps what it built in a state file.";
      s.demo.demo = demo("waiting", { scenario: "failure", about, intro });
      renderKiosk(bar, s, new Date("2026-10-15T03:01:00Z"));
      expect(find(bar, "k-intro")).toEqual([]);
      s.demo.demo = demo("reset", { scenario: "failure", about, intro });
      renderKiosk(bar, s, new Date("2026-10-15T03:01:00Z"));
      const shown = find(bar, "k-intro");
      expect(shown).toHaveLength(1);
      expect(shown[0].children.map((c) => c.textContent)).toEqual([INTRO_HEAD, intro]);
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
      const head = find(panel, "k-ap-head")[0];
      expect([head.textContent, ...head.children.map((c) => c.textContent)].join("")).toBe("How this hold ends · wave 2 plan 0accc105ba06 · times in UTC");
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
  it("shows the resources for the pull request's steps and the roots by wave from the merge on", () => {
    for (const step of ["pull-request", "planned"]) expect(stepView(step)).toBe("resources");
    for (const step of ["merged", "applying", "waiting", "approved", "failed", "resumed", "applied", "reset"]) expect(stepView(step)).toBe("components");
    expect(Object.keys(STEP_VIEW).sort()).toEqual(Object.keys(STEP_WORDS).sort());
  });

  it("follows the step, and only the resources when the repo offers no components zoom", () => {
    expect(kioskView(demo("planned"), { components: true })).toEqual({ view: "resources", pinned: false, secs: null });
    expect(kioskView(demo("waiting"), { components: true })).toEqual({ view: "components", pinned: false, secs: null });
    expect(kioskView(demo("waiting"), { components: false })).toEqual({ view: "resources", pinned: false, secs: null });
    expect(kioskView(demo("waiting"), { components: false, pick: { view: "components", at: 0 }, now: 1000 }).view).toBe("resources");
    expect(kioskView(null, { components: true }).view).toBe("resources");
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

  it("says how to read the view shown", () => {
    expect(legendWords("components")).toMatch(/^Each card is a Terraform root .* titled with the pipeline job that applies it/);
    expect(legendWords("resources")).toMatch(/^Each box is a Terraform root/);
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
      expect(buttons.map((b) => [b.textContent, b.attrs["aria-pressed"]])).toEqual([["Resources", "false"], ["Roots by wave", "true"]]);
      expect(host.children[1].textContent).toBe("follows the step");
      buttons[0].listeners.click();
      expect(picked).toEqual(["resources"]);

      renderViewToggle(host, { view: "resources", pinned: true, secs: 42 }, { components: true });
      expect(host.children[1].textContent).toBe("held by a click; the step leads again in 42 s");

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

  it("shows the intro first in the bar, and none without one", () => {
    const { bar } = draw(demo("planned", { intro }));
    expect(bar.children[0].className).toBe("k-intro");
    expect(bar.children[0].textContent).toBe(intro);
    expect(find(draw(demo("planned")).bar, "k-intro")).toEqual([]);
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
    } finally {
      globalThis.document = was;
    }
  });
});
