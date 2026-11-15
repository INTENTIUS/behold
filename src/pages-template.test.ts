import { describe, it, expect, vi, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYAML } from "@intentius/chant/yaml";
import type { GraphIR } from "@intentius/chant";

// #1074: the GitHub Pages workflow template. The refusal on a private
// repository is a shell step, so it is run here under bash with the event
// values the runner would give it. The marker check runs the real export.
vi.mock("./chant.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chant.ts")>()),
  graphIr: vi.fn(),
}));
import { graphIr } from "./chant.ts";
import { runExport } from "./export.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TEMPLATE = join(ROOT, "templates", "github-pages.yml");
const DOC = join(ROOT, "docs", "src", "content", "docs", "using", "pages.mdx");

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; if?: string };
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  env: Record<string, string>;
  jobs: Record<string, { permissions?: Record<string, string>; steps: Step[] }>;
};
const workflow = parseYAML(readFileSync(TEMPLATE, "utf8")) as unknown as Workflow;
const steps = workflow.jobs.build!.steps;
const stepNamed = (re: RegExp): Step => steps.find((s) => s.name && re.test(s.name))!;

function bash(script: string, env: Record<string, string>) {
  const r = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH!, ...env }, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("the Pages workflow template (#1074)", () => {
  it("deploys with pages: write and id-token: write on the deploy job only", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.build!.permissions).toBeUndefined();
    expect(workflow.jobs.deploy!.permissions).toEqual({ pages: "write", "id-token": "write" });
  });

  it("runs on a push to main and by hand, with the allow-private-repo input", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push).toEqual({ branches: ["main"] });
    const dispatch = workflow.on.workflow_dispatch as { inputs: Record<string, { type: string; default: boolean }> };
    expect(dispatch.inputs["allow-private-repo"]).toMatchObject({ type: "boolean", default: false });
  });

  it("pins every action to a commit", () => {
    for (const job of Object.values(workflow.jobs))
      for (const s of job.steps) if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it("exports with --no-source by default and the size limit at 1 GB", () => {
    expect(workflow.env.NO_SOURCE).toBe("true");
    expect(Number(workflow.env.MAX_SITE_KB)).toBeLessThanOrEqual(1_048_576);
    expect(stepNamed(/^Export$/).run).toContain('export . $flags --out "$out"');
  });

  it("refuses before anything is checked out, built or uploaded", () => {
    expect(steps[0]!.name).toMatch(/private/i);
    const upload = steps.findIndex((s) => s.uses?.includes("upload-pages-artifact"));
    expect(upload).toBeGreaterThan(0);
    expect(steps.findIndex((s) => s.uses?.includes("checkout"))).toBeGreaterThan(0);
  });

  describe("the refusal step", () => {
    const run = stepNamed(/private/i).run!;
    const go = (event: { VISIBILITY?: string; IS_PRIVATE?: string }, allow = "false") =>
      bash(run, { VISIBILITY: "", IS_PRIVATE: "", ...event, ALLOW_PRIVATE_REPO: allow });

    it("passes a public repository", () => {
      expect(go({ VISIBILITY: "public", IS_PRIVATE: "false" }).code).toBe(0);
      expect(go({ IS_PRIVATE: "false" }).code).toBe(0);
    });

    it.each([
      ["private", { VISIBILITY: "private", IS_PRIVATE: "true" }],
      ["internal", { VISIBILITY: "internal", IS_PRIVATE: "true" }],
      ["private, visibility absent", { IS_PRIVATE: "true" }],
      ["unknown, nothing in the event", {}],
    ])("fails a %s repository and says the site would be public", (_n, event) => {
      const r = go(event);
      expect(r.code).toBe(1);
      expect(r.out).toContain("would be public on the internet");
      expect(r.out).toContain("allow-private-repo");
    });

    it.each(["private", "internal"])("passes a %s repository with the input set, and warns", (visibility) => {
      const r = go({ VISIBILITY: visibility, IS_PRIVATE: "true" }, "true");
      expect(r.code).toBe(0);
      expect(r.out).toContain("::warning::");
    });

    it("keeps refusing when the input is anything but true", () => {
      expect(go({ VISIBILITY: "private" }, "yes").code).toBe(1);
      expect(go({ VISIBILITY: "private" }, "").code).toBe(1);
    });
  });

  describe("the site path step", () => {
    const run = stepNamed(/site path/i).run!;
    it("takes a relative path and an empty one", () => {
      expect(bash(run, { SITE_PATH: "" }).code).toBe(0);
      expect(bash(run, { SITE_PATH: "estate/infra" }).code).toBe(0);
    });
    it.each(["/abs", "../up", "a/../b"])("refuses %s", (p) => {
      expect(bash(run, { SITE_PATH: p }).code).toBe(1);
    });
  });

  describe("the size step", () => {
    const run = stepNamed(/size/i).run!;
    const inSite = (bytes: number) => {
      const dir = mkdtempSync(join(tmpdir(), "behold-pages-size-"));
      made.push(dir);
      const r = spawnSync("bash", ["-c", `mkdir _site && head -c ${bytes} /dev/zero > _site/f && ${run}`], {
        cwd: dir,
        env: { PATH: process.env.PATH!, MAX_SITE_KB: "100" },
        encoding: "utf8",
      });
      return { code: r.status, out: r.stdout + r.stderr };
    };
    it("passes a site under the limit", () => {
      expect(inSite(20_000).code).toBe(0);
    });
    it("fails a site over the limit and names the 1 GB cap", () => {
      const r = inSite(400_000);
      expect(r.code).toBe(1);
      expect(r.out).toContain("1 GB limit");
    });
  });

  it("is the workflow the docs page shows, word for word", () => {
    const doc = readFileSync(DOC, "utf8");
    const block = /```yaml title="\.github\/workflows\/behold-pages\.yml"\n([\s\S]*?)\n```/.exec(doc);
    expect(block).not.toBeNull();
    expect(block![1]).toBe(readFileSync(TEMPLATE, "utf8").trimEnd());
  });
});

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("a bundle published with the template's flags holds no source text (#1074)", () => {
  it("leaves a marker comment in a Terraform root's source out of every file", { timeout: 180_000 }, async () => {
    const MARKER = "BEHOLD-1074-SOURCE-MARKER";
    const ir = JSON.parse(readFileSync(join(HERE, "__fixtures__", "terraform-ir-two-roots.json"), "utf8")) as GraphIR;
    for (const n of ir.nodes) (n.attrs as Record<string, unknown>).source = `# ${MARKER}\nresource "aws_s3_bucket" "b" {}`;
    vi.mocked(graphIr).mockImplementation((async () => structuredClone(ir)) as never);

    const project = mkdtempSync(join(tmpdir(), "behold-pages-src-"));
    const base = mkdtempSync(join(tmpdir(), "behold-pages-out-"));
    made.push(project, base);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runExport({ projectDir: project, port: 0 }, join(base, "with"));
      await runExport({ projectDir: project, port: 0 }, join(base, "without"), { noSource: true });
    } finally {
      write.mockRestore();
    }
    const holds = (dir: string) =>
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .some((e) => readFileSync(join(e.parentPath, e.name)).includes(MARKER));
    expect(holds(join(base, "with"))).toBe(true);
    expect(holds(join(base, "without"))).toBe(false);
  });
});
