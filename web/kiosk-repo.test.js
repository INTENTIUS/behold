// behold#571: the kiosk asks for its repo's checkout by name, on a behold that serves several.
import { describe, expect, it } from "vitest";
import { repoParam, repoUrl, stepCheckout } from "./kiosk-repo.js";
import { frameSrc } from "./kiosk.js";
import { pageRepo, withRepo } from "./view-repo.js";

describe("repoParam", () => {
  it("is the checkout name when the server serves it, else null", () => {
    expect(repoParam("terragucci-admin/demo-terragrunt", ["demo", "demo-terragrunt"])).toBe("demo-terragrunt");
    expect(repoParam("terragucci-admin/demo-cdk", ["demo", "demo-terragrunt"])).toBeNull();
    expect(repoParam("terragucci-admin/demo", null)).toBeNull();
    expect(repoParam(null, ["demo"])).toBeNull();
  });
});

describe("repoUrl", () => {
  it("adds the repo to the reads about the checkout only", () => {
    expect(repoUrl("/api/project", "demo-terragrunt")).toBe("/api/project?repo=demo-terragrunt");
    expect(repoUrl("/api/terragucci?fresh=1", "demo-terragrunt")).toBe("/api/terragucci?fresh=1&repo=demo-terragrunt");
    expect(repoUrl("/api/terragucci/progress?commit=abc", "demo")).toBe("/api/terragucci/progress?commit=abc&repo=demo");
    expect(repoUrl("/api/terragucci/lifecycle", "demo")).toBe("/api/terragucci/lifecycle?repo=demo");
    expect(repoUrl("/api/lifecycle/history?limit=200", "demo")).toBe("/api/lifecycle/history?limit=200&repo=demo");
    // behold#631: the hold panel's read of a chant repo's gate is that repo's, not the default checkout's.
    expect(repoUrl("/api/chant/pr?pin=a157c47f", "demo-chant")).toBe("/api/chant/pr?pin=a157c47f&repo=demo-chant");
    expect(repoUrl("/api/terragucci/demo", "demo")).toBe("/api/terragucci/demo");
    expect(repoUrl("/api/terragucci/runs/4", "demo")).toBe("/api/terragucci/runs/4");
    expect(repoUrl("/api/project", null)).toBe("/api/project");
  });
});

describe("stepCheckout (behold#571)", () => {
  const served = ["demo", "demo.change", "demo-terragrunt", "demo-terragrunt.change"];
  const HEAD = "9eec25f7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const MERGE = "12f512fcbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const BASE = "0d14834dcccccccccccccccccccccccccccccccc";
  const commits = { demo: BASE, "demo.change": HEAD, "demo-terragrunt": BASE };
  const step = (step, commit) => ({ scenario: "b-waves", step, commit });
  it("draws the checkout at the pull request's head while the step is about it", () => {
    expect(stepCheckout("demo", step("pull-request", HEAD), served, commits)).toBe("demo.change");
    expect(stepCheckout("demo", step("planned", HEAD.slice(0, 8)), served, commits)).toBe("demo.change");
  });
  it("follows the merge once the driver checked it out, and draws the repo's checkout until then", () => {
    expect(stepCheckout("demo", step("merged", MERGE), served, commits)).toBe("demo");
    expect(stepCheckout("demo", step("merged", MERGE), served, { ...commits, "demo.change": MERGE })).toBe("demo.change");
  });
  it("draws the repo's own checkout at the reset, on the base, and with no commit or commits", () => {
    expect(stepCheckout("demo", step("reset", HEAD), served, commits)).toBe("demo");
    expect(stepCheckout("demo", { scenario: "base", step: "applied", commit: HEAD }, served, commits)).toBe("demo");
    expect(stepCheckout("demo", step("pull-request", null), served, commits)).toBe("demo");
    expect(stepCheckout("demo", step("pull-request", HEAD), served, null)).toBe("demo");
    expect(stepCheckout(null, step("pull-request", HEAD), served, commits)).toBe(null);
  });
  it("picks only the repo's own checkouts", () => {
    expect(stepCheckout("demo-terragrunt", step("pull-request", HEAD), served, commits)).toBe("demo-terragrunt");
  });
});

describe("the frame", () => {
  it("names the repo it draws, and nothing without one", () => {
    expect(frameSrc("http://h", "resources")).toBe("/?embed=1&bare=1&zoom=resources&host=http%3A%2F%2Fh");
    expect(frameSrc("http://h", "components", "demo-terragrunt")).toBe("/?embed=1&bare=1&zoom=components&host=http%3A%2F%2Fh&repo=demo-terragrunt");
  });
  it("carries the page's repo on each of its own /api/ reads", () => {
    expect(pageRepo("?embed=1&repo=demo-terragrunt")).toBe("demo-terragrunt");
    expect(pageRepo("?embed=1")).toBeNull();
    expect(withRepo("/api/graph?zoom=resources", "demo-terragrunt", "http://h")).toBe("/api/graph?zoom=resources&repo=demo-terragrunt");
    expect(withRepo("http://h/api/project", "demo-terragrunt", "http://h")).toBe("http://h/api/project?repo=demo-terragrunt");
    expect(withRepo("/api/project?repo=demo", "demo-terragrunt", "http://h")).toBe("/api/project?repo=demo");
    expect(withRepo("./manifest.json", "demo-terragrunt", "http://h")).toBe("./manifest.json");
    expect(withRepo("https://elsewhere/api/x", "demo-terragrunt", "http://h")).toBe("https://elsewhere/api/x");
  });
});
