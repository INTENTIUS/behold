// behold#571: the per-tool pages' pure parts: live or replay, the replay's pace, the runs kept, and the branding.
import { describe, expect, it } from "vitest";
import { VENDOR_TOOLS } from "../src/terragucci-demo.ts";
import { logRows } from "./kiosk-runs.js";
import { NO_GRAPH_WORDS, SCENARIOS, legendWords, scenarioHead } from "./kiosk.js";
import {
  REPLAY_LAST_HOLD_MS,
  RUNS_WITH,
  VENDORS,
  creditLines,
  demoTool,
  filterIndex,
  keepRun,
  liveEstimate,
  liveFor,
  linkSegments,
  namesOther,
  notRunRepo,
  notRunWords,
  otherTerms,
  replayAt,
  replayBanner,
  replayIndex,
  rootWord,
  runAsOf,
  scrubDemo,
  servesRepo,
  stepDurations,
  toolCheckout,
} from "./kiosk-vendor.js";

const demo = (extra = {}) => ({ cycle: 3, scenario: "b-waves", title: "A new subnet", step: "waiting", label: "Wave 2 waits", started_at: "2026-10-20T10:00:00Z", next: { action: "approve wave-2", at: null }, pull: 41, commit: "abc", about: null, intro: null, name: "a new subnet", scenarios: 3, index: 2, ...extra });

describe("which tool a page is live for (behold#571)", () => {
  it("is demo.json's tool, and Terraform's for a driver before it that ran a scenario the kiosk knows", () => {
    expect(demoTool(demo({ tool: "terragrunt" }), SCENARIOS)).toBe("terragrunt");
    expect(demoTool(demo(), SCENARIOS)).toBe("terraform");
    expect(demoTool(demo({ scenario: "tg-new" }), SCENARIOS)).toBe(null);
  });
  it("is live only for the tool whose scenario runs, never on the base", () => {
    expect(liveFor(demo({ tool: "terragrunt" }), "terragrunt", SCENARIOS)).toBe(true);
    expect(liveFor(demo({ tool: "terragrunt" }), "terraform", SCENARIOS)).toBe(false);
    expect(liveFor(demo({ tool: "terraform", scenario: "base" }), "terraform", SCENARIOS)).toBe(false);
    expect(liveFor(null, "terraform", SCENARIOS)).toBe(false);
  });
});

describe("the runs a tool's page keeps (behold#571)", () => {
  const index = { doc: { schema: "demo.runs/v1", runs: [{ id: 3, repo: "admin/demo-terragrunt", tool: "terragrunt" }, { id: 2, repo: "admin/demo", tool: "terraform" }, { id: 1, tool: "terragrunt" }, { id: 0 }] } };
  it("keeps the repo's runs, a run's tool without a repo, and a run with neither on Terraform's page alone", () => {
    expect(filterIndex(index, { tool: "terragrunt", repo: "admin/demo-terragrunt" }).doc.runs.map((r) => r.id)).toEqual([3, 1]);
    expect(filterIndex(index, { tool: "terraform", repo: "admin/demo" }).doc.runs.map((r) => r.id)).toEqual([2, 0]);
    expect(keepRun({ id: 9, repo: "admin/demo" }, { tool: "terraform", repo: null })).toBe(false);
  });
  it("leaves an answer that is no index as it came", () => {
    const absent = { doc: null, absent: "no runs" };
    expect(filterIndex(absent, { tool: "terraform", repo: "x" })).toBe(absent);
  });
  it("shows the graph only for the repo this behold serves", () => {
    expect(servesRepo("forgejo:3000/admin/demo", "admin/demo")).toBe(true);
    expect(servesRepo("forgejo:3000/admin/demo", "admin/demo-terragrunt")).toBe(false);
    expect(servesRepo("forgejo:3000/xadmin/demo", "admin/demo")).toBe(false);
    expect(servesRepo(null, "admin/demo")).toBe(false);
  });
});

describe("the replay's pace (behold#571)", () => {
  const steps = [
    { step: "pull-request", at: "2026-10-20T10:00:00Z" },
    { step: "planned", at: "2026-10-20T10:00:40Z" },
    { step: "merged", at: "2026-10-20T10:01:30Z" },
    { step: "reset", at: "2026-10-20T10:03:00Z" },
  ];
  it("holds each step as long as it was recorded, and the last for the driver's hold", () => {
    expect(stepDurations(steps)).toEqual([40_000, 50_000, 90_000, REPLAY_LAST_HOLD_MS]);
  });
  it("steps through at that pace, standing for the step's time plus the time into it, and loops", () => {
    expect(replayAt(steps, 0).index).toBe(0);
    expect(replayAt(steps, 39_999).index).toBe(0);
    const p = replayAt(steps, 45_000);
    expect(p.index).toBe(1);
    expect(p.at.toISOString()).toBe("2026-10-20T10:00:45.000Z");
    expect(replayAt(steps, 180_000).index).toBe(3);
    const loop = 180_000 + REPLAY_LAST_HOLD_MS;
    expect(replayAt(steps, 0).loop).toBe(loop);
    expect(replayAt(steps, loop + 45_000).index).toBe(1);
  });
});

describe("a run as it stood in the replay (behold#571)", () => {
  const run = {
    id: 7,
    status: "success",
    created_at: "2026-10-20T10:00:00Z",
    started_at: "2026-10-20T10:00:00Z",
    ended_at: "2026-10-20T10:01:40Z",
    jobs: [
      { id: 1, name: "plan", needs: [], status: "success", started_at: "2026-10-20T10:00:00Z", ended_at: "2026-10-20T10:01:40Z", steps: [{ name: "Plan", status: "success", started_at: "2026-10-20T10:00:00Z", ended_at: "2026-10-20T10:01:40Z", log: ["1", "2", "3", "4"] }] },
      { id: 2, name: "fmt", needs: [], status: "skipped", started_at: null, ended_at: null, steps: [] },
    ],
  };
  const t = (iso) => Date.parse(iso);
  it("is queued before it started, running until it ended with its log so far, then as it ended", () => {
    expect(runAsOf(run, t("2026-10-20T09:59:00Z")).jobs[0].status).toBe("queued");
    const mid = runAsOf(run, t("2026-10-20T10:00:50Z"));
    expect([mid.status, mid.ended_at, mid.jobs[0].status, mid.jobs[0].steps[0].log]).toEqual(["running", null, "running", ["1", "2"]]);
    expect(mid.jobs[1].status).toBe("skipped");
    const end = runAsOf(run, t("2026-10-20T10:02:00Z"));
    expect([end.status, end.jobs[0].steps[0].log.length]).toEqual(["success", 4]);
  });
  it("lists the cycle's runs created by then, newest first", () => {
    const later = { ...run, id: 8, created_at: "2026-10-20T10:05:00Z", started_at: "2026-10-20T10:05:00Z", ended_at: "2026-10-20T10:06:00Z" };
    expect(replayIndex([run, later], t("2026-10-20T10:01:00Z")).doc.runs.map((r) => r.id)).toEqual([7]);
    expect(replayIndex([run, later], t("2026-10-20T10:07:00Z")).doc.runs.map((r) => r.id)).toEqual([8, 7]);
  });
});

describe("the replay's banner (behold#571)", () => {
  const cycle = { started: "2026-10-20T14:05:00Z", ended: "2026-10-20T14:09:00Z", steps: [{ index: 3, scenarios: 3, at: "2026-10-20T14:05:00Z" }] };
  it("says when the replayed run was, and about when the tool is live again", () => {
    expect(replayBanner(cycle, 6)).toBe("Replay of the run at 14:05 UTC · live again in about 6 min");
    expect(replayBanner(cycle, null)).toBe("Replay of the run at 14:05 UTC");
  });
  it("estimates from the loop's order and the cycle's length, and not without them", () => {
    const now = new Date("2026-10-20T15:01:00Z");
    // Scenario 1 of 3 started a minute ago; scenario 2 runs before the tool's 3rd: 3 min left, then 4.
    expect(liveEstimate({ index: 1, scenarios: 3, started_at: "2026-10-20T15:00:00Z" }, cycle, now)).toBe(7);
    // Scenario 2 is live: the tool's is next.
    expect(liveEstimate({ index: 2, scenarios: 3, started_at: "2026-10-20T15:00:00Z" }, cycle, now)).toBe(3);
    expect(liveEstimate({ index: null, scenarios: 3, started_at: "2026-10-20T15:00:00Z" }, cycle, now)).toBe(null);
    expect(liveEstimate({ index: 1, scenarios: 4, started_at: "2026-10-20T15:00:00Z" }, cycle, now)).toBe(null);
  });
});

describe("the branding table (behold#571)", () => {
  it("has a page for every tool the server routes, and nothing else", () => {
    expect(Object.keys(VENDORS)).toEqual([...VENDOR_TOOLS]);
  });
  it("links every name to an official https site, and shows a logo for choudoufu alone", () => {
    for (const v of Object.values(VENDORS)) expect(v.url).toMatch(/^https:\/\//);
    expect(Object.entries(VENDORS).filter(([, v]) => v.logo).map(([id]) => id)).toEqual(["choudoufu"]);
    expect(VENDORS["cdk-terrain"].url).toBe("https://cdktn.io/");
    expect(VENDORS.terraform.credit).toContain("Terraform is a trademark of HashiCorp.");
  });
  it("says on each page who makes the tool and that they don't endorse the demo, naming no other tool or maker", () => {
    for (const tool of VENDOR_TOOLS) {
      const v = VENDORS[tool];
      const words = [v.name, ...creditLines(tool).map((l) => l.map((s) => s.text).join("")), ...Object.values(notRunWords(v)), legendWords("components", tool), legendWords("resources", tool)];
      for (const w of words) expect(namesOther(w, tool), `${tool}: ${w}`).toBe(false);
      // choudoufu is ours: its credit says so instead.
      if (tool !== "choudoufu") expect(v.credit).toMatch(/(does not|don't) endorse this demo\./);
    }
    expect(VENDORS.choudoufu.credit).toMatch(/AWS and Kubernetes/);
    expect(VENDORS.choudoufu.credit).not.toMatch(/experimental/i);
  });
  it("links each name in the footer, the tool's to its site and OpenTofu's where its scenarios run on it", () => {
    const tf = creditLines("terraform");
    expect(tf.flat().filter((s) => s.url).map((s) => [s.text, s.url])).toEqual([
      ["Terraform", VENDORS.terraform.url],
      ["OpenTofu", RUNS_WITH.opentofu.url],
    ]);
    expect(creditLines("terragrunt").flat().filter((s) => s.url).map((s) => s.text)).toEqual(["Terragrunt"]);
    expect(linkSegments("a b a", [{ name: "a", url: "u" }])).toEqual([{ text: "a", url: "u" }, { text: " b a" }]);
  });
  it("counts as a competitor each other tool of the same kind: engines with engines, orchestrators with orchestrators", () => {
    const matrix = Object.fromEntries(VENDOR_TOOLS.map((t) => [t, otherTerms(t)]));
    expect(matrix).toEqual({
      // OpenTofu is an engine too, but Terraform's scenarios really run on it.
      terraform: ["choudoufu"],
      terragrunt: ["CDK Terrain", "CDKTN", "Open Construct", "Atmos", "Cloud Posse", "Terramate"],
      "cdk-terrain": ["Terragrunt", "Gruntwork", "Atmos", "Cloud Posse", "Terramate"],
      choudoufu: ["Terraform", "HashiCorp", "OpenTofu"],
    });
    expect(otherTerms(null)).toEqual([]);
  });
  it("lets an orchestrator's page name the engines it runs on, and keeps an engine's page from naming another engine", () => {
    expect(namesOther("Big Terraform setups run on OpenTofu", "terragrunt")).toBe(false);
    expect(namesOther("Big Terraform setups", "cdk-terrain")).toBe(false);
    expect(namesOther("compare with Atmos", "terragrunt")).toBe(true);
    expect(namesOther("Terragrunt units", "cdk-terrain")).toBe(true);
    expect(namesOther("Big Terraform setups", "choudoufu")).toBe(true);
    expect(namesOther("Terraform.", "choudoufu")).toBe(true);
    expect(namesOther("runs on choudoufu", "terraform")).toBe(true);
    expect(namesOther("works with OpenTofu", "terraform")).toBe(false);
    expect(rootWord("choudoufu")).toBe("a root");
    expect(rootWord("terragrunt")).toBe("a Terraform root");
  });
  it("never counts a resource address, a bucket or a path as a brand", () => {
    for (const t of ["terraform_data.app", "data.terraform_remote_state.network", "state in demo-terraform-state", "s3://demo-terraform-state/edge.tfstate", "developer.hashicorp.com/terraform", ".terraform.lock.hcl", "terragrunt-cache"]) {
      expect(namesOther(t, "choudoufu"), t).toBe(false);
      expect(namesOther(t, "cdk-terrain"), t).toBe(false);
    }
  });
  it("leaves out the driver's words that name a competitor, and the loop's count", () => {
    const d = scrubDemo(demo({ intro: "Big Terraform setups split", about: { changes: "A unit changes", watch: "Terramate plans", shows: "It waits" }, label: "Atmos applies wave 2", title: "CDK Terrain roots" }), "terragrunt");
    expect([d.intro, d.label, d.title, d.scenarios, d.index]).toEqual(["Big Terraform setups split", "", "a new subnet", null, null]);
    expect(d.about).toEqual({ changes: "A unit changes", shows: "It waits" });
    expect(scenarioHead(d, { vendor: "terragrunt" })).toEqual({ kicker: "Scenario · a new subnet", title: "a new subnet" });
    expect(scenarioHead(demo(), { vendor: "terraform" }).kicker).not.toMatch(/of 3|\d/);
    expect(scrubDemo(demo({ intro: "Big Terraform setups split" }), "choudoufu").intro).toBe(null);
  });
  it("leaves a log line naming a competitor out, says how many, and keeps the engine's lines on an orchestrator's page", () => {
    const rows = logRows(["plan ok", "Terramate binary", "Terraform v1.9", "edge: s3://demo-terraform-state/edge.tfstate"], { hide: (l) => namesOther(l, "terragrunt") });
    expect(rows).toEqual([{ n: 1, text: "plan ok" }, { n: 3, text: "Terraform v1.9" }, { n: 4, text: "edge: s3://demo-terraform-state/edge.tfstate" }, { hidden: 1 }]);
  });
});

describe("a tool's page, drawn (behold#571)", () => {
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
  const text = (n) => (n.children && n.children.length ? n.children.map(text).join("") : n.textContent || "");
  const all = (n) => [n, ...(n.children || []).flatMap(all)];
  it("puts the tool's name before the scenario, the banner over it, and the credit in the foot, with no count", async () => {
    const { renderKiosk } = await import("./kiosk.js");
    const was = globalThis.document;
    globalThis.document = fakeDocument();
    try {
      const bar = document.createElement("header");
      const foot = document.createElement("footer");
      const about = { changes: "A unit changes", watch: "Terramate would plan it too", shows: "It waits" };
      const s = { vendor: "terragrunt", mode: "replay", replay: { banner: "Replay of the run at 14:05 UTC" }, noReports: true, demo: { demo: scrubDemo(demo({ tool: "terragrunt", intro: "Big Terraform setups", about }), "terragrunt") }, answer: null, progress: null };
      renderKiosk(bar, s, new Date("2026-10-20T10:01:00Z"), foot);
      expect(bar.children[0].className).toBe("k-replay");
      const title = all(bar).find((n) => n.className === "k-title");
      expect(title.children.map((c) => c.className)).toEqual(["k-brand", "k-kicker", "k-title-text"]);
      const brand = title.children[0];
      expect([brand.href, brand.target, brand.rel, text(brand)]).toEqual([VENDORS.terragrunt.url, "_blank", "noopener", "Terragrunt"]);
      expect(text(bar)).not.toMatch(/of 3|Terramate/);
      // behold#571: no intro band at a live step; the intro fills the card's box at reset.
      expect(text(bar)).not.toContain("Big Terraform setups");
      // The engine Terragrunt runs on is no competitor: the shared intro stays.
      const reset = { ...s, demo: { demo: { ...s.demo.demo, step: "reset" } } };
      const bar2 = document.createElement("header");
      renderKiosk(bar2, reset, new Date("2026-10-20T10:01:00Z"), document.createElement("footer"));
      expect(text(bar2)).toContain("Big Terraform setups");
      // No graph of this repo here: one line in the header says so.
      expect(all(bar).filter((n) => n.className === "k-nograph-note").map(text)).toEqual([NO_GRAPH_WORDS]);
      expect(all(foot).filter((n) => n.className === "k-credit").map(text)).toEqual([VENDORS.terragrunt.credit]);
    } finally {
      globalThis.document = was;
    }
  });
  it("names the checkout of a tool's repo, and offers it before the first cycle only when it is served", () => {
    expect(toolCheckout("terraform")).toBe("demo");
    expect(toolCheckout("terragrunt")).toBe("demo-terragrunt");
    expect(toolCheckout("nope")).toBe(null);
    expect(notRunRepo("terragrunt", ["demo", "demo-terragrunt"])).toBe("demo-terragrunt");
    expect(notRunRepo("terragrunt", ["demo"])).toBe(null);
    expect(notRunRepo("terragrunt", null)).toBe(null);
    expect(notRunRepo("nope", ["demo"])).toBe(null);
  });
  it("says the graph below is the repo on the base only when there is one", () => {
    expect(notRunWords(VENDORS.terragrunt).text).not.toContain("Below");
    expect(notRunWords(VENDORS.terragrunt, { graph: true }).text).toContain("Below, its repo as it stands on the base.");
    expect(notRunWords(VENDORS.terragrunt, { graph: true }).title).toBe("This scenario hasn't run yet");
  });
  it("says calmly that a tool's scenario hasn't run yet, with its name and link", async () => {
    const { renderKiosk } = await import("./kiosk.js");
    const was = globalThis.document;
    globalThis.document = fakeDocument();
    try {
      const bar = document.createElement("header");
      const foot = document.createElement("footer");
      renderKiosk(bar, { vendor: "choudoufu", mode: "none", demo: null }, new Date(), foot);
      expect(text(bar)).toContain("This scenario hasn't run yet");
      const brand = all(bar).find((n) => n.className === "k-brand");
      expect(brand.href).toBe(VENDORS.choudoufu.url);
      expect(all(brand).some((n) => n.className === "k-brand-logo" && n.src === VENDORS.choudoufu.logo.src)).toBe(true);
    } finally {
      globalThis.document = was;
    }
  });
});
