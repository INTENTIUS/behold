import { describe, expect, it } from "vitest";
import { FORGES, answerUrls, markLink, componentsForge, detectForge, forgeOfName, forgeOfPath, forgeOfUrl, markTitle, waveJobUrl } from "./forge-mark.js";

// behold#571: which forge runs a wave, from what behold already reads.
describe("forge detection", () => {
  it("reads a forge named outright", () => {
    expect(forgeOfName("forgejo")).toBe("forgejo");
    expect(forgeOfName("GitHub Actions")).toBe("github");
    expect(forgeOfName("gitlab-ci")).toBe("gitlab");
    expect(forgeOfName("woodpecker")).toBeNull();
    expect(forgeOfName(undefined)).toBeNull();
  });

  it("reads a pipeline file's path", () => {
    expect(forgeOfPath(".forgejo/workflows/terragucci.yml")).toBe("forgejo");
    expect(forgeOfPath("./.github/workflows/deploy.yml")).toBe("github");
    expect(forgeOfPath(".gitlab-ci.yml")).toBe("gitlab");
    expect(forgeOfPath("ci/pipeline.yml")).toBeNull();
  });

  it("reads a run URL's host and path shape", () => {
    expect(forgeOfUrl("https://github.com/acme/shop/actions/runs/9/job/31")).toBe("github");
    expect(forgeOfUrl("https://gitlab.com/acme/shop/-/jobs/12")).toBe("gitlab");
    expect(forgeOfUrl("https://git.acme.dev/acme/shop/-/jobs/12")).toBe("gitlab");
    expect(forgeOfUrl("https://codeberg.org/acme/shop/actions/runs/4/jobs/1")).toBe("forgejo");
    expect(forgeOfUrl("http://forgejo:3000/admin/demo-terragrunt/actions/runs/448/jobs/3")).toBe("forgejo");
    expect(forgeOfUrl("https://ghe.acme.dev/acme/shop/actions/runs/9/job/31")).toBe("github");
    expect(forgeOfUrl("https://ci/9131")).toBeNull();
    expect(forgeOfUrl("not a url")).toBeNull();
    expect(forgeOfUrl("javascript:alert(1)")).toBeNull();
  });

  it("takes a named forge first, then the run URLs, then the path", () => {
    const gh = ["https://github.com/a/b/actions/runs/1/job/2"];
    expect(detectForge({ declared: "forgejo", urls: gh })).toBe("forgejo");
    expect(detectForge({ urls: gh, path: ".forgejo/workflows/x.yml" })).toBe("github");
    expect(detectForge({ path: ".forgejo/workflows/x.yml" })).toBe("forgejo");
    expect(detectForge({ found: "gitlab" })).toBe("gitlab");
  });

  it("says no forge when nothing says, or the run URLs disagree", () => {
    expect(detectForge({})).toBeNull();
    expect(detectForge({ urls: ["https://ci/1"], path: "ci.yml" })).toBeNull();
    expect(detectForge({ urls: ["https://github.com/a/b/actions/runs/1/job/2", "https://gitlab.com/a/b/-/jobs/3"], path: ".forgejo/workflows/x.yml" })).toBeNull();
  });

  it("reads a components graph's facets and the reports' URLs", () => {
    const answer = { roots: [{ path: "app", apply: { wave: 2, job_url: "https://codeberg.org/a/b/actions/runs/4/jobs/1" } }], waiting: [] };
    expect(componentsForge({ forge: "forgejo", forgeFrom: "declared" }, null)).toBe("forgejo");
    expect(componentsForge({ forge: "github", forgeFrom: "config" }, answer)).toBe("github");
    // A workflow directory is the weakest word: the reports' URLs outrank it.
    expect(componentsForge({ forge: "github", forgeFrom: "workflow-dir" }, answer)).toBe("forgejo");
    expect(componentsForge({ forge: "github", forgeFrom: "workflow-dir" }, null)).toBe("github");
    expect(componentsForge({ pipeline: ".gitlab-ci.yml" }, null)).toBe("gitlab");
    expect(componentsForge({ jobs: [] }, null)).toBeNull();
    expect(componentsForge(null, answer)).toBeNull();
    expect(answerUrls({ error: "x" })).toEqual([]);
  });
});

describe("a wave's job URL", () => {
  const answer = {
    roots: [
      { path: "network", apply: { wave: 1, commit: "aaa111", finished: "2026-10-15T04:10:00Z", job_url: "https://f/r/actions/runs/7/jobs/2" } },
      { path: "app", apply: { wave: 2, commit: "aaa111", finished: "2026-10-15T04:12:00Z", job_url: "https://f/r/actions/runs/7/jobs/3" } },
      { path: "ledger", apply: { wave: 2, commit: "bbb222", finished: "2026-10-15T04:20:00Z", job_url: "https://f/r/actions/runs/9/jobs/3" } },
      { path: "edge", plan: { job_url: "https://f/r/actions/runs/6/jobs/1" } },
    ],
    waiting: [{ wave: 3, commit: "bbb222", since: "2026-10-15T04:21:00Z", job_url: "https://f/r/actions/runs/9/jobs/4" }],
  };

  it("is the URL a report carried for that wave, on the drawn commit", () => {
    expect(waveJobUrl(answer, 2, "aaa111")).toBe("https://f/r/actions/runs/7/jobs/3");
    expect(waveJobUrl(answer, 2, "bbb2")).toBe("https://f/r/actions/runs/9/jobs/3");
    expect(waveJobUrl(answer, 3, "bbb222")).toBe("https://f/r/actions/runs/9/jobs/4");
  });

  it("is the newest with no commit drawn", () => {
    expect(waveJobUrl(answer, 2)).toBe("https://f/r/actions/runs/9/jobs/3");
  });

  it("is null when no report has one", () => {
    expect(waveJobUrl(answer, 4)).toBeNull();
    expect(waveJobUrl(answer, 1, "bbb222")).toBeNull();
    expect(waveJobUrl(null, 1)).toBeNull();
  });
});

describe("the mark's link", () => {
  it("is the report's URL, unless that URL is another forge's", () => {
    expect(markLink("https://github.com/a/b/actions/runs/9/job/1", "github")).toBe("https://github.com/a/b/actions/runs/9/job/1");
    expect(markLink("https://ci.acme.dev/jobs/9", "forgejo")).toBe("https://ci.acme.dev/jobs/9");
    expect(markLink("https://github.com/a/b/actions/runs/9", "forgejo")).toBeNull();
    expect(markLink(null, "github")).toBeNull();
  });
});

describe("the mark", () => {
  it("says the job and the forge", () => {
    expect(markTitle("apply-wave-2", "forgejo")).toBe("apply-wave-2 on Forgejo");
    expect(markTitle(null, "github")).toBe("Runs on GitHub");
    expect(markTitle("x", "bitbucket")).toBe("");
  });

  it("has every forge's name and an inline icon, with no external URL", () => {
    for (const f of Object.values(FORGES)) {
      expect(f.label).toMatch(/^(Forgejo|GitHub|GitLab)$/);
      expect(JSON.stringify(f)).not.toMatch(/https?:/);
    }
  });

});
