// behold#571: the per-tool pages' pure parts: live or replay, the replay's pace, the runs kept, and the branding.
import { describe, expect, it } from "vitest";
import { VENDOR_TOOLS } from "../src/terragucci-demo.ts";
import { logRows } from "./kiosk-runs.js";
import { NO_GRAPH_WORDS, SCENARIOS, WHAT_TITLE, readingRows, scenarioHead, whatParts, whatTitle } from "./kiosk.js";
import {
  REPLAY_LAST_HOLD_MS,
  RUNS_WITH,
  VENDORS,
  creditLines,
  demoTool,
  filterIndex,
  keepRun,
  kioskVendorOf,
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
    expect(Object.entries(VENDORS).filter(([, v]) => v.logo).map(([id]) => id)).toEqual(["choudoufu", "choudoufu-fanout"]);
    expect(VENDORS["cdk-terrain"].url).toBe("https://cdktn.io/");
    expect(VENDORS.terraform.credit).toContain("Terraform is a trademark of HashiCorp.");
  });
  it("says on each page who makes the tool and that they don't endorse the demo, naming no other tool or maker", () => {
    for (const tool of VENDOR_TOOLS) {
      const v = VENDORS[tool];
      const words = [v.name, ...creditLines(tool).map((l) => l.map((s) => s.text).join("")), ...Object.values(notRunWords(v)), ...readingRows("components", tool).map((r) => r.words), ...readingRows("resources", tool).map((r) => r.words)];
      for (const w of words) expect(namesOther(w, tool), `${tool}: ${w}`).toBe(false);
      // choudoufu and chant are ours: their credits say so instead.
      if (v.owner !== "Intentius") expect(v.credit).toMatch(/(does not|don't) endorse this demo\./);
    }
    expect(VENDORS.choudoufu.credit).toMatch(/AWS and Kubernetes/);
    expect(VENDORS.choudoufu.credit).not.toMatch(/experimental/i);
  });
  it("links each name in the credit, the tool's to its site and OpenTofu's where its scenarios run on it", () => {
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
      // A pipeline: no other tool with a page is one.
      chant: [],
      // behold#746: the fan-outs compete with each other; chant's page leaves out terragucci and its tofu image too.
      "chant-fanout": ["OpenTofu", "choudoufu", "terragucci", "tofu"],
      "tofu-fanout": ["choudoufu"],
      "choudoufu-fanout": ["OpenTofu"],
    });
    expect(otherTerms(null)).toEqual([]);
  });
  it("keeps the chant approve lines on every page, since chant is a pipeline and competes with no engine or orchestrator", () => {
    for (const tool of VENDOR_TOOLS) expect(namesOther("chant approve tf-apply wave-2 --actor demo-reviewer --sign", tool), tool).toBe(false);
    expect(VENDORS.chant.url).toBe("https://intentius.io/chant/");
    expect(VENDORS.chant.owner).toBe("Intentius");
    expect(creditLines("chant").flat().filter((s) => s.url).map((s) => s.text)).toEqual(["chant", "OpenTofu"]);
    expect(toolCheckout("chant")).toBe("demo-chant");
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
    expect(rootWord("terragrunt")).toBe("a Terragrunt unit");
    expect(rootWord("terraform")).toBe("a Terraform root");
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
  it("puts the tool's name before the scenario, the banner over it, and the credit at the lead block's foot, with no count", async () => {
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
      // behold#571: the tool and the kicker on the quiet line over the title, the scenario's progress at its end.
      const over = all(bar).find((n) => n.className === "k-overline");
      expect(over.children.map((c) => c.className)).toEqual(["k-brand", "k-kicker", "k-strip"]);
      expect(all(bar).find((n) => n.className === "k-title").children.map((c) => c.className)).toEqual(["k-title-text"]);
      const brand = over.children[0];
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
      // behold#571: no footer: the credit is the lead block's last line.
      const lead = all(bar).find((n) => n.className === "k-left k-lead");
      expect(lead.children[lead.children.length - 1].className).toBe("k-credits");
      expect(all(bar).filter((n) => n.className === "k-credit").map(text)).toEqual([VENDORS.terragrunt.credit]);
      expect(foot.children).toEqual([]);
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
      // The credit shows on every tool page, before its first cycle too.
      expect(all(bar).filter((n) => n.className === "k-credit").map(text)).toEqual([VENDORS.choudoufu.credit]);
      expect(all(brand).some((n) => n.className === "k-brand-logo" && n.src === VENDORS.choudoufu.logo.src)).toBe(true);
    } finally {
      globalThis.document = was;
    }
  });
});

describe("a page per fan-out tool (behold#746)", () => {
  const FANOUTS = ["chant-fanout", "tofu-fanout", "choudoufu-fanout"];
  const fan = (tool, extra = {}) =>
    demo({ scenario: { "chant-fanout": "fan-out", "tofu-fanout": "fan-out-tofu", "choudoufu-fanout": "fan-out-choudoufu" }[tool], tool, repo: `terragucci-admin/${toolCheckout(tool)}`, title: "A broken stack shouldn't stall the whole rollout", name: "fifteen stacks", intro: "Big Terraform setups split what they build across many states.", ...extra });
  const BANNED = /terragucci|opentofu|tofu/i;

  it("routes each fan-out tool to a page of its own, its product's name in the title", () => {
    for (const t of FANOUTS) expect(VENDOR_TOOLS).toContain(t);
    expect([VENDORS["chant-fanout"].name, VENDORS["tofu-fanout"].name, VENDORS["choudoufu-fanout"].name]).toEqual(["chant", "OpenTofu", "choudoufu"]);
    expect(FANOUTS.map(toolCheckout)).toEqual(["demo-chant-fanout", "demo-fanout", "demo-choudoufu-fanout"]);
  });
  it("is live only while its own fan-out runs, and replays its latest cycle otherwise", () => {
    for (const live of FANOUTS) for (const page of FANOUTS) expect(liveFor(fan(live), page, SCENARIOS), `${live} on ${page}`).toBe(live === page);
    // The vendor pages are no fan-out's: chant's own page replays while chant's fan-out runs.
    expect(liveFor(fan("chant-fanout"), "chant", SCENARIOS)).toBe(false);
    expect(liveFor(fan("chant-fanout", { scenario: "base" }), "chant-fanout", SCENARIOS)).toBe(false);
  });
  it("keeps its own repo's runs alone", () => {
    const index = { doc: { runs: [{ id: 3, repo: "terragucci-admin/demo-chant-fanout" }, { id: 2, repo: "terragucci-admin/demo-fanout" }, { id: 1, repo: "terragucci-admin/demo-choudoufu-fanout" }] } };
    expect(filterIndex(index, { tool: "chant-fanout", repo: "terragucci-admin/demo-chant-fanout" }).doc.runs.map((r) => r.id)).toEqual([3]);
    expect(filterIndex(index, { tool: "tofu-fanout", repo: "terragucci-admin/demo-fanout" }).doc.runs.map((r) => r.id)).toEqual([2]);
  });
  it("leaves terragucci and OpenTofu off chant's page, inside an identifier too, and keeps Terraform and chant", () => {
    for (const t of ["terragucci · OpenTofu · on Forgejo", "image: terragucci-demo-tofu:local", "OpenTofu v1.9.0", "http://localhost:3300/terragucci-admin/demo-chant-fanout.git", "tofu init", "The demo stack and its driver are terragucci's.", "runs on choudoufu"]) {
      expect(namesOther(t, "chant-fanout"), t).toBe(true);
    }
    for (const t of ["chant pr-plan: 15 member(s), planned", "chant approve pr-763 pr-apply --plan jcs1-sha256:8d30", "Big Terraform setups split", "cluster-a failed"]) expect(namesOther(t, "chant-fanout"), t).toBe(false);
    // Each word chant's page leaves out today, and more.
    for (const t of otherTerms("chant")) expect(otherTerms("chant-fanout")).toContain(t);
  });
  it("shows each fan-out page only its own product: the others' names go, terragucci stays where it is the pipeline", () => {
    expect(namesOther("choudoufu live-import", "tofu-fanout")).toBe(true);
    expect(namesOther("OpenTofu v1.9.0", "choudoufu-fanout")).toBe(true);
    for (const t of ["tofu-fanout", "choudoufu-fanout"]) {
      expect(namesOther("terragucci · on Forgejo · fan out", t), t).toBe(false);
      expect(namesOther("chant approve tf-apply wave-2 --actor demo-reviewer --sign", t), t).toBe(false);
    }
    expect(namesOther("terragucci · OpenTofu", "tofu-fanout")).toBe(false);
  });
  it("leaves /kiosk's branding as it was: no fan-out brand there, the vendor pages' as before", () => {
    for (const t of FANOUTS) expect(kioskVendorOf(t), t).toBe(null);
    expect(kioskVendorOf("chant")).toBe(VENDORS.chant);
    expect(kioskVendorOf("terraform")).toBe(VENDORS.terraform);
    expect(kioskVendorOf(null)).toBe(null);
    for (const view of ["components", "resources"]) expect(readingRows(view, "chant-fanout")).toEqual(readingRows(view, null));
  });
  it("says whose pipeline it is on chant's page, without the sentence that names terragucci", () => {
    const hide = (t) => namesOther(t, "chant-fanout");
    expect(whatTitle(null, hide)).toBe("The pipeline is chant's (chant components pr-plan / pr-apply on Forgejo).");
    expect(whatTitle(null)).toBe(WHAT_TITLE);
    expect(whatParts({ scenario: "fan-out" }, "forgejo", null, hide).map((p) => p.text)).toEqual(["chant's pull-request pipeline", "on Forgejo", "fan-out", "live demo"]);
    // Were chant's page ever drawn on a terragucci repo, the line would drop terragucci and its engine.
    expect(whatParts({ scenario: "fan-out" }, "forgejo", { tools: ["opentofu"] }, hide).map((p) => p.text)).toEqual(["on Forgejo", "fan-out", "live demo"]);
    expect(whatParts({ scenario: "fan-out-tofu" }, "forgejo", { tools: ["opentofu"] }, (t) => namesOther(t, "tofu-fanout")).map((p) => p.text)).toEqual(["terragucci", "OpenTofu", "on Forgejo", "fan out tofu", "live demo"]);
  });
  it("draws chant's page, live and in replay, in Inspect and in Watch, with no terragucci or OpenTofu anywhere", async () => {
    const { renderKiosk } = await import("./kiosk.js");
    const was = globalThis.document;
    const make = (tag) => {
      const n = { tagName: tag, className: "", textContent: "", children: [], attrs: {} };
      n.appendChild = (c) => (n.children.push(c), c);
      n.append = (...cs) => cs.forEach((c) => n.children.push(typeof c === "string" ? { tagName: "#text", textContent: c, children: [], attrs: {} } : c));
      n.replaceChildren = () => (n.children = []);
      n.setAttribute = (k, v) => (n.attrs[k] = String(v));
      n.querySelectorAll = () => [];
      n.addEventListener = () => {};
      return n;
    };
    globalThis.document = { createElement: make };
    const words = (n) => [n.textContent || "", n.href || "", ...Object.values(n.attrs || {}), ...(n.children || []).flatMap(words)];
    try {
      const d = scrubDemo(fan("chant-fanout", { step: "planned", label: "The plan covers fifteen stacks. image: terragucci-demo-tofu:local", about: { changes: "A pull request edits the shared network.", watch: "OpenTofu plans the stacks", shows: "A failure blocks only what depends on it." } }), "chant-fanout");
      for (const mode of ["live", "replay"]) {
        for (const watchMode of [false, true]) {
          const bar = make("header");
          const s = { vendor: "chant-fanout", mode, replay: mode === "replay" ? { banner: "Replay of the run at 00:39 UTC · live again in about 2 min" } : null, demo: { demo: d }, answer: { error: "s3://demo-reports/demo/index.json lists 7 projects, and none is this checkout's (localhost:3300/terragucci-admin/demo-chant-fanout)." }, progress: null, watchMode, chantLoop: true, trackOn: true, chantForge: () => "forgejo" };
          renderKiosk(bar, s, new Date("2026-10-20T10:01:00Z"));
          const all = words(bar).join("\n");
          expect(all, `${mode} ${watchMode ? "watch" : "inspect"}`).not.toMatch(BANNED);
          expect(all).toContain("chant");
          if (watchMode) expect(all).toContain("chant's pull-request pipeline");
          if (mode === "replay") expect(all).toContain("Replay of the run at 00:39 UTC");
          // Replaying, the line says so and drops its "live demo".
          if (mode === "replay" && watchMode) expect(all).not.toContain("live demo");
        }
      }
      // The credit, the not-run words and the legend say neither.
      const fixed = [...creditLines("chant-fanout").map((l) => l.map((x) => x.text).join("")), ...Object.values(notRunWords(VENDORS["chant-fanout"])), ...readingRows("components", "chant-fanout").map((r) => r.words)];
      for (const w of fixed) expect(w).not.toMatch(BANNED);
    } finally {
      globalThis.document = was;
    }
  });
});
