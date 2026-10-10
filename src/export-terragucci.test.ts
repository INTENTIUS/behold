import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GraphIR } from "@intentius/chant";

// #491: `behold export --terragucci` is the view terragucci's estate job
// uploads to `<prefix>/views/behold/`. The estate read is the one seam mocked
// (it needs chant's terraform lexicon, which CI does not have): it answers the
// IR recorded from the real read of terragucci's example.
vi.mock("./estate.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./estate.ts")>()),
  composeEstate: vi.fn(),
}));
import { composeEstate } from "./estate.ts";
import { exportScrubber, runExport, shapeSnapshot, VIEWS_REPORTS_BASE } from "./export.ts";

const HERE = import.meta.dirname;
const BUCKET = join(HERE, "..", "example-terragucci-reports");
const SECRET = "behold-test-secret-7c1f0e";
const IR = (): GraphIR => {
  const ir = JSON.parse(readFileSync(join(HERE, "__fixtures__", "terragucci-example-ir.json"), "utf8")) as GraphIR;
  // What a Terraform card carries today: its root's whole file.
  for (const n of ir.nodes) (n.attrs as Record<string, unknown>).source = `resource "aws_s3_bucket" "x" {} # ${n.id}`;
  return { ...ir, edges: [], groups: {} };
};

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
  delete process.env.BEHOLD_TEST_SECRET;
});

function checkout(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "behold-tg-export-")), "tg-example");
  made.push(dirname(dir));
  for (const env of ["dev", "staging", "prod"]) {
    for (const svc of ["platform", "email", "orders", "payments", "search"]) {
      mkdirSync(join(dir, "envs", env, svc), { recursive: true });
      writeFileSync(join(dir, "envs", env, svc, "main.tf"), 'terraform {\n  required_version = "~> 1.13.0"\n}\n\nresource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n');
    }
  }
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "terragucci.yml"), "binary: tofu\n");
  return dir;
}

const quiet = async (f: () => Promise<void>) => {
  const w = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await f();
  } finally {
    w.mockRestore();
  }
};

/** Every file in a bundle, as text. */
const bundleText = (dir: string): string =>
  (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => /\.(json|html|md|jsonc)$/.test(f))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");

describe("behold export --terragucci (#491)", () => {
  it("captures the same dated marks serve answers, with report links relative to the bucket", { timeout: 60_000 }, async () => {
    vi.mocked(composeEstate).mockImplementation((async () => IR()) as never);
    const dir = checkout();
    const out = join(mkdtempSync(join(tmpdir(), "behold-tg-view-")), "views", "behold");
    made.push(dirname(dirname(out)));
    await quiet(() => runExport({ projectDir: dir, projectDirs: [dir], port: 0, terragucci: { source: BUCKET } }, out));
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { keyToFile: Record<string, string> };
    const tg = JSON.parse(readFileSync(join(out, manifest.keyToFile["/api/terragucci"]!), "utf8")) as {
      files: string;
      cards: Record<string, { run: { finished: string; report: string } }[]>;
      waiting: { command: string }[];
      estate: { html: string };
    };
    expect(tg.files).toBe(VIEWS_REPORTS_BASE);
    expect(Object.keys(tg.cards)).toHaveLength(4);
    // Dated by the run, so the view says "4h ago" when it is opened, not when it was made.
    expect(tg.cards["tg-example/envs-staging-orders/module.service/aws_sqs_queue.jobs"]![0]!.run.finished).toBe("2026-10-08T06:04:12.000Z");
    expect(tg.waiting[0]!.command).toMatch(/^npx terragucci approve wave-2 --plan /);
    // From <prefix>/views/behold/, ../../<key> is the bucket object itself.
    expect(tg.estate.html).toBe("estate.html");
    const project = JSON.parse(readFileSync(join(out, manifest.keyToFile["/api/project"]!), "utf8")) as Record<string, unknown>;
    expect(project.terragucciReports).toBeTruthy();
  });

  it("carries no secret, no path of the capturing machine, no recents and no user name", { timeout: 60_000 }, async () => {
    process.env.BEHOLD_TEST_SECRET = SECRET;
    vi.mocked(composeEstate).mockImplementation((async () => IR()) as never);
    const dir = checkout();
    const out = join(mkdtempSync(join(tmpdir(), "behold-tg-view-")), "bundle");
    made.push(dirname(out));
    await quiet(() => runExport({ projectDir: dir, projectDirs: [dir], port: 0, terragucci: { source: BUCKET } }, out));
    const text = bundleText(out);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(dir);
    expect(text).not.toContain(dirname(dir));
    expect(text).not.toContain(homedir());
    expect(text).not.toContain(BUCKET);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { keyToFile: Record<string, string>; projectDir: string };
    expect(manifest.projectDir).toBe("tg-example");
    const project = JSON.parse(readFileSync(join(out, manifest.keyToFile["/api/project"]!), "utf8")) as Record<string, unknown>;
    expect(project).not.toHaveProperty("recents");
    expect(project).not.toHaveProperty("approver");
  });

  it("leaves every card's source text out on --no-source, and keeps it otherwise", { timeout: 60_000 }, async () => {
    vi.mocked(composeEstate).mockImplementation((async () => IR()) as never);
    const dir = checkout();
    const base = mkdtempSync(join(tmpdir(), "behold-tg-view-"));
    made.push(base);
    await quiet(() => runExport({ projectDir: dir, projectDirs: [dir], port: 0, terragucci: { source: BUCKET } }, join(base, "with")));
    await quiet(() => runExport({ projectDir: dir, projectDirs: [dir], port: 0, terragucci: { source: BUCKET } }, join(base, "without"), { noSource: true }));
    expect(bundleText(join(base, "with"))).toContain('resource \\"aws_s3_bucket\\" \\"x\\"');
    expect(bundleText(join(base, "without"))).not.toContain('resource \\"aws_s3_bucket\\" \\"x\\"');
  });

  it("fails instead of publishing a view with no marks when the reports can't be read", { timeout: 60_000 }, async () => {
    vi.mocked(composeEstate).mockImplementation((async () => IR()) as never);
    const dir = checkout();
    const out = join(mkdtempSync(join(tmpdir(), "behold-tg-view-")), "bundle");
    made.push(dirname(out));
    await expect(quiet(() => runExport({ projectDir: dir, projectDirs: [dir], port: 0, terragucci: { source: dir } }, out))).rejects.toThrow(/terragucci reports not read: .*has no index\.json/);
  });
});

describe("shapeSnapshot and exportScrubber (#491)", () => {
  it("points report keys at the bucket, by default from <prefix>/views/behold/", () => {
    expect(JSON.parse(shapeSnapshot("/api/terragucci", JSON.stringify({ files: "/api/terragucci/file?key=" }))).files).toBe("../../");
    expect(JSON.parse(shapeSnapshot("/api/terragucci", JSON.stringify({ files: "x" }), { reportsBase: "https://r.example/" })).files).toBe("https://r.example/");
  });

  it("passes a body that is not JSON through", () => {
    expect(shapeSnapshot("/api/graph", "<svg/>")).toBe("<svg/>");
  });

  it("names served directories by their basename and home by ~, longest first", () => {
    const scrub = exportScrubber({ projectDir: "/home/u/repos/infra", projectDirs: ["/home/u/repos/infra", "/home/u/repos/infra/envs"] }, "/home/u");
    expect(scrub('{"a":"/home/u/repos/infra/envs/x","b":"/home/u/repos/infra","c":"/home/u/other"}')).toBe('{"a":"envs/x","b":"infra","c":"~/other"}');
  });
});
