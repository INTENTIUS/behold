import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexWords } from "./kiosk-runs.js";
import { askBody, ciPlanRows, compareHeads, offerView } from "./local-run.js";

// behold#685: the "Run locally" tab's words. The CI runs are the run index
// fixture as GET /api/chant/ci/runs answers it (src/ci-run-index.ts ciRunOf).
const INDEX = JSON.parse(readFileSync(join(import.meta.dirname, "..", "src", "__fixtures__", "chant-demo", "reports", "runs", "index.json"), "utf8"));
const asRuns = { doc: { schema: "demo.runs/v1", runs: INDEX.runs.map((r) => ({ id: r.runId, job: r.job, pull: r.pr, commit: r.commit, member: r.member ?? null, status: r.status === "ok" ? "success" : "failure" })) } };

describe("what the tab offers (behold#685)", () => {
  it("offers plan when behold says so, and says why when it does not", () => {
    const on = offerView({ offer: { jobs: ["plan"], refusal: null, apply: "behold runs plan jobs locally, never apply", env: "prod", members: ["app"], ciIndex: true } });
    expect(on).toMatchObject({ can: true, refusal: null, env: "prod", members: ["app"], ciIndex: true });
    expect(on.apply).toMatch(/never apply/);
    const old = offerView({ offer: { jobs: [], refusal: { error: "Local CI run needs chant 0.124.32 or newer. This project has chant 0.124.31.", remedy: "Upgrade @intentius/chant to 0.124.32 or newer in the project." }, apply: "x", env: null, members: [], ciIndex: false } });
    expect(old).toMatchObject({ can: false, refusal: "Local CI run needs chant 0.124.32 or newer. This project has chant 0.124.31.", remedy: "Upgrade @intentius/chant to 0.124.32 or newer in the project." });
    expect(offerView({ error: "behold is serving a public, read-only view" }).can).toBe(false);
  });
  it("lists CI's plan jobs of a pull request, never an apply", () => {
    const rows = ciPlanRows(asRuns);
    expect(rows.map((r) => r.text)).toEqual(["plan of #775 at 9b1e3f0c · web · succeeded", "plan of #774 at 47f4df6d · succeeded", "plan of #773 at 6d4a48da · succeeded"]);
    expect(rows[0]).toMatchObject({ commit: "9b1e3f0c2d4a5b6c7d8e9f00112233445566778a", pr: 775, member: "web" });
    expect(ciPlanRows({ doc: null, absent: "no index" })).toEqual([]);
  });
});

describe("the ask", () => {
  it("is a plan with a commit and its pull request, and the rest only when given", () => {
    expect(askBody({ commit: " 4843c95 ", pr: "7", env: "", base: "", member: "", forge: "" })).toEqual({ body: { job: "plan", commit: "4843c95", pr: 7 } });
    expect(askBody({ commit: "4843c95", pr: "7", env: "prod", base: "8923f55", member: "app", forge: "github" })).toEqual({ body: { job: "plan", commit: "4843c95", pr: 7, env: "prod", base: "8923f55", member: "app", forge: "github" } });
    expect(askBody({ commit: "main", pr: "7" }).error).toMatch(/sha/);
    expect(askBody({ commit: "4843c95", pr: "" }).error).toMatch(/pull request's number/);
  });
});

describe("the two halves", () => {
  it("names where each ran, and says so when chant did not run it locally", () => {
    expect(compareHeads({ doc: { base: "8923f557a020", env: "prod", where: { forge: "local", runtime: "local" } } })).toEqual({ local: "This machine · chant ci run plan --local · base 8923f557 · prod", ci: "CI · from chant's run index" });
    expect(compareHeads({ doc: { base: "8923f557a020", env: "prod", where: { forge: "chant", runtime: "ci" } } }).local).toMatch(/chant said it ran on chant$/);
  });
  it("puts the member and chant's failure code beside a local run's status, as for CI's", () => {
    expect(indexWords({ from: "chant-ci-local", member: "app", failure: "command-failed" })).toEqual(["app", "failed: command-failed"]);
  });
});
