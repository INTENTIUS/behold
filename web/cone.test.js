// Report minor 34: a cone plan on the stage. The answers are the server's own
// for the three pull request plans in src/__fixtures__/terragucci-cone (a
// cone, a fallback, and another binary's plan with no cone field), built by
// the same functions /api/terragucci answers with.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pullRequestPlan } from "../src/terragucci-reports.ts";
import { coneView, plannedInstances } from "../src/terragucci-cone.ts";
import { backendLine, blockPath, cardRoot, coneFact, coneLights, coneLine, coneOf, coneResourceLines, resourceLight, rootLight, shortAddress } from "./cone.js";
import { componentMarks } from "./terragucci-components-live.js";
import { rootStates } from "./terragucci-change.js";
import { captionModel, coneCaption } from "./kiosk-watch.js";
import { coneLines } from "./kiosk.js";
import { coneGlow } from "./dots.js";

const FIX = join(import.meta.dirname, "..", "src", "__fixtures__", "terragucci-cone");
const json = (...p) => JSON.parse(readFileSync(join(FIX, ...p), "utf8"));
const ROOTS = ["network", "service-a", "service-b"];
const facts = Object.fromEntries(ROOTS.map((r) => [r, { binary: "choudoufu" }]));

/** The pull request stage /api/terragucci answers for a fixture plan, with its cone view when it has one. */
function prOf(run) {
  const doc = json("runs", run, "report.json");
  const pr = pullRequestPlan(doc, `runs/${run}/report.html`);
  const planned = { "service-b": plannedInstances(json("runs", run, "service-b.plan.json")) };
  const cone = coneView(doc, { roots: ROOTS, planned: run === "pr-cone" ? planned : {}, facts });
  return cone ? { ...pr, cone } : pr;
}
const answerOf = (run) => ({ roots: ROOTS.map((path) => ({ member: path, name: path, path })), pull_request: prOf(run) });
const demo = (step, more = {}) => ({ cycle: 3, scenario: "cone", title: "One change, planned as a cone", step, label: `the ${step} line`, started_at: "2026-10-17T10:01:00Z", next: null, pull: 7, commit: "2222222", about: { changes: "A pull request changes service-b's inline policy." }, ...more });

describe("a cone plan's words (minor 34)", () => {
  it("says the cone's size from the report's numbers, the roots it did not plan, and the one backend", () => {
    const cone = coneOf(prOf("pr-cone"));
    expect(coneLine(cone)).toBe("service-b: 2 of 6 blocks, as a cone · network, service-a: not planned");
    expect(backendLine(cone)).toBe("3 estates · 1 backend · no state files");
    expect(coneFact(cone.roots[0])).toBe("2 of 6 blocks, as a cone");
  });

  it("says plainly that choudoufu planned in full, with the guard's reason", () => {
    const cone = coneOf(prOf("pr-fallback"));
    expect(coneLine(cone)).toBe("service-b planned in full: a provider block changed · network, service-a: not planned");
    expect(coneFact(cone.roots[0])).toBe("planned in full: a provider block changed");
  });

  it("with one root and nothing else, says it in the brief's words", () => {
    expect(coneLine({ roots: [{ root: ".", kind: "cone", blocks: 2, of: 16 }] })).toBe("Planned as a cone: 2 of 16 blocks. The rest of the estate was not read.");
    expect(coneLine({ roots: [{ root: ".", kind: "full", fallback: { kind: "cone-too-large", reason: "the cone is over 30% of the estate's blocks" } }] })).toBe("Planned in full: the cone is over 30% of the estate's blocks.");
    expect(coneLine({ roots: [{ root: ".", kind: "cone", targets: 1 }] })).toBe("Planned as a cone: 1 address. The rest of the estate was not read.");
  });
});

describe("a cone plan's lights (minor 34)", () => {
  it("lights what the cone planned, rings what it changes, and dims the rest of its root and the roots it did not plan", () => {
    const L = coneLights(coneOf(prOf("pr-cone")));
    expect(resourceLight(L, "service-b", "aws_iam_role_policy.service_b")).toBe("changed");
    expect(resourceLight(L, "service-b", "aws_iam_role.service_b")).toBe("lit");
    expect(resourceLight(L, "service-b", "aws_sqs_queue.jobs")).toBe("dim");
    expect(resourceLight(L, "network", "aws_vpc.main")).toBe("dim");
    expect(rootLight(L, "service-b")).toBe("lit");
    expect(rootLight(L, "network")).toBe("dim");
  });

  it("lights every resource of a root planned in full", () => {
    const L = coneLights(coneOf(prOf("pr-fallback")));
    expect(resourceLight(L, "service-b", "aws_sqs_queue.jobs")).toBe("lit");
    expect(rootLight(L, "service-b")).toBe("lit");
    expect(rootLight(L, "service-a")).toBe("dim");
  });

  it("finds a card's root and address by the stage's node ids, by instance or block path", () => {
    const L = coneLights(coneOf(prOf("pr-cone")));
    const roots = answerOf("pr-cone").roots;
    // A Terraform member: <member>/<root name>/<block path>.
    expect(cardRoot("service-b/service-b/aws_iam_role.service_b", L, roots)).toEqual({ root: "service-b", address: "aws_iam_role.service_b" });
    // A choudoufu member named for the root's directory: <member>/<address>.
    expect(cardRoot("service-b/aws_iam_role_policy.service_b", L, [])).toEqual({ root: "service-b", address: "aws_iam_role_policy.service_b" });
    expect(cardRoot("other/aws_vpc.main", L, [])).toBeNull();
    expect(blockPath('module.svc.aws_iam_role.r["a.b"]')).toBe("module.svc/aws_iam_role.r");
    const Lm = coneLights({ roots: [{ root: "r", kind: "cone", planned: [{ address: 'module.svc.aws_iam_role.r["x"]', changed: false }] }] });
    expect(resourceLight(Lm, "r", "module.svc/aws_iam_role.r")).toBe("lit");
  });

  it("lights a cone whose plan.json was not read at its box only, its cards as they were", () => {
    const L = coneLights({ roots: [{ root: "service-b", kind: "cone", blocks: 2, of: 6 }] });
    expect(rootLight(L, "service-b")).toBe("lit");
    expect(resourceLight(L, "service-b", "aws_iam_role.service_b")).toBeNull();
  });

  it("glows a dot or a roster card as the light says", () => {
    expect(coneGlow("changed", "#c80")).toEqual({ colour: "#c80", a: 1, ring: true, dim: false });
    expect(coneGlow("lit", "#c80")).toMatchObject({ ring: false, dim: false });
    expect(coneGlow("dim", "#c80")).toMatchObject({ a: 0, dim: true });
    expect(coneGlow(null, "#c80")).toBeNull();
  });
});

describe("a cone plan on the boxes and in the kiosk (minor 34)", () => {
  it("puts the cone's size on its root's box, and says not planned on the others", () => {
    const { roots } = rootStates(answerOf("pr-cone"), null);
    expect(roots["service-b"]).toMatchObject({ state: "planned", words: "wave 1 · planned · 2 of 6 blocks, as a cone", cone: "cone" });
    expect(roots["service-b"].facts[0]).toBe("2 of 6 blocks, as a cone");
    // The cone's resources, two short lines for the card's body: the change first, then what the plan only read.
    expect(roots["service-b"].lines).toEqual(["iam_role_policy.service_b · changed", "iam_role.service_b · read"]);
    expect(roots.network).toMatchObject({ state: "outside", words: "not planned", cone: "not-planned" });
    expect(rootStates(answerOf("pr-fallback"), null).roots["service-b"]).toMatchObject({ words: "wave 1 · planned in full: a provider block changed" });
    expect(rootStates(answerOf("pr-fallback"), null).roots["service-b"]).not.toHaveProperty("lines");
  });

  it("carries the cone onto the components view's cards: the words, the short form, the lines", () => {
    const a = answerOf("pr-cone");
    const facets = { jobs: ["network", "service-a", "service-b"].map((c, i) => ({ component: c, wave: i === 0 ? 1 : 2, jobName: `apply-wave-${i === 0 ? 1 : 2}` })), roots: {} };
    const { cards } = componentMarks(a, null, facets);
    expect(cards["service-b"]).toMatchObject({ words: "planned · 2 of 6 blocks, as a cone", short: "planned", cone: "cone", lines: ["iam_role_policy.service_b · changed", "iam_role.service_b · read"] });
    expect(cards.network).toMatchObject({ words: "not planned", short: "not planned", cone: "not-planned" });
    expect(cards.network).not.toHaveProperty("lines");
  });

  it("cuts a long cone to two lines and counts the rest", () => {
    const r = { kind: "cone", planned: [{ address: "aws_a.x", changed: false }, { address: "module.m.aws_b.y", changed: true }, { address: "aws_c.z", changed: false }] };
    expect(coneResourceLines(r)).toEqual(["module.m.b.y · changed", "a.x · read · and 1 more"]);
    expect(coneResourceLines({ kind: "full" })).toEqual([]);
    expect(shortAddress("aws_iam_role.service")).toBe("iam_role.service");
  });

  it("writes the line in Watch's caption and Inspect's notes while the step shows the pull request's plan", () => {
    const a = answerOf("pr-cone");
    const want = { line: "service-b: 2 of 6 blocks, as a cone · network, service-a: not planned", backend: "3 estates · 1 backend · no state files" };
    expect(coneCaption(demo("planned"), a)).toEqual(want);
    expect(captionModel(demo("planned"), { answer: a }).cone).toEqual(want);
    expect(coneLines(demo("planned"), a).map((l) => l.text)).toEqual([want.line, want.backend]);
    // From the merge on, the waves plan in full: no cone line.
    expect(coneCaption(demo("applying"), a)).toBeNull();
    // Another cycle's pull request is never this one's.
    expect(coneCaption(demo("planned", { pull: 8 }), a)).toBeNull();
  });

  it("changes nothing for a plan with no cone field (another binary)", () => {
    const a = answerOf("pr-plain");
    expect(a.pull_request).not.toHaveProperty("cone");
    expect(coneOf(a.pull_request)).toBeNull();
    expect(coneLights(coneOf(a.pull_request))).toBeNull();
    expect(resourceLight(null, "service-b", "aws_iam_role.service_b")).toBeNull();
    expect(rootLight(null, "network")).toBeNull();
    expect(coneLine(null)).toBeNull();
    expect(backendLine(null)).toBeNull();
    const { roots } = rootStates(a, null);
    expect(roots["service-b"]).toEqual({ wave: 1, state: "planned", tone: "plan", words: "wave 1 · planned", facts: ["plan sha256:bbbbb"] });
    expect(roots.network).toEqual({ wave: null, state: "outside", tone: "idle", words: "unchanged", facts: [] });
    expect(coneCaption(demo("planned"), a)).toBeNull();
    expect(captionModel(demo("planned"), { answer: a }).cone).toBeNull();
    expect(coneLines(demo("planned"), a)).toEqual([]);
  });
});
