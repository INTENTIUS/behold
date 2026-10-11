import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";

// #490: the routes over terragucci's example. The one seam mocked is the
// estate read, which needs chant's terraform lexicon (an optional peer, so CI
// has none): it answers the IR recorded from the real read of the example.
vi.mock("./estate.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./estate.ts")>()),
  composeEstate: vi.fn(),
}));
import { composeEstate } from "./estate.ts";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";

const HERE = import.meta.dirname;
const BUCKET = join(HERE, "..", "example-terragucci-reports");
const IR = (): GraphIR => ({ ...(JSON.parse(readFileSync(join(HERE, "__fixtures__", "terragucci-example-ir.json"), "utf8")) as GraphIR), edges: [], groups: {} });

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** terragucci's example, as far as root discovery reads it: 15 roots, a terragucci.yml, a git root. */
function checkout(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "behold-tg-route-")), "tg-example");
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
const dirname = (p: string): string => p.slice(0, p.lastIndexOf("/"));

function served(opts: { terragucci?: boolean } = { terragucci: true }) {
  const dir = checkout();
  const broadcaster = new Broadcaster();
  return createApp(
    { projectDir: dir, projectDirs: [dir], port: 0, ...(opts.terragucci ? { terragucci: { source: BUCKET } } : {}) },
    broadcaster,
    new FrameBuffer(),
    new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }),
  );
}

beforeEach(() => {
  vi.mocked(composeEstate).mockReset();
  vi.mocked(composeEstate).mockImplementation((async () => IR()) as never);
});

describe("GET /api/terragucci (#490)", () => {
  it("answers each root's newest runs, the cards they flag, the waiting wave and terragucci's own counts", async () => {
    const res = await served().request("/api/terragucci");
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      project: string;
      files: string;
      estate: { drifted: number; waiting: number; html: string };
      roots: { path: string; drift?: { changes: number } }[];
      cards: Record<string, { verdict: string }[]>;
      waiting: { wave: number; command: string }[];
      unmatched: { roots: string[]; changes: unknown[] };
    };
    expect(j.project).toBe("github.com/acme/shop");
    expect(j.roots).toHaveLength(15);
    expect(j.unmatched).toEqual({ roots: [], changes: [] });
    expect(j.cards["tg-example/envs-staging-orders/module.service/aws_sqs_queue.jobs"]![0]!.verdict).toBe("drift");
    expect(j.estate).toMatchObject({ drifted: 1, waiting: 1, html: "estate.html" });
    expect(j.waiting.map((w) => w.wave)).toEqual([2]);
    expect(j.waiting[0]!.command).toMatch(/^npx terragucci approve wave-2 --plan jcs1-sha256:[0-9a-f]{64}$/);
    expect(j.files).toBe("/api/terragucci/file?key=");
  });

  it("is absent unless serve was given --terragucci", async () => {
    expect((await served({}).request("/api/terragucci")).status).toBe(404);
    const project = (await (await served({}).request("/api/project")).json()) as { terragucciReports?: unknown };
    expect(project.terragucciReports).toBeUndefined();
  });

  it("tells the page to ask for the marks", async () => {
    const project = (await (await served().request("/api/project")).json()) as { terragucciReports?: { source: string } };
    expect(project.terragucciReports?.source).toBe(BUCKET);
  });

  it("refuses a source with no reports, structurally", async () => {
    const dir = checkout();
    const broadcaster = new Broadcaster();
    const app = createApp({ projectDir: dir, projectDirs: [dir], port: 0, terragucci: { source: dir } }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
    const res = await app.request("/api/terragucci");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("terragucci-report");
  });

  it("has no approve route: a waiting wave is approved at a shell", async () => {
    const app = served();
    for (const path of ["/api/terragucci/approve", "/api/terragucci/approve/wave-2"]) {
      // A terragucci repo refuses every write before routing (#500), so the
      // answer is 409; the route list is what shows no approve route exists.
      expect((await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(409);
    }
    expect(app.routes.filter((r) => r.path.startsWith("/api/terragucci") && r.method !== "GET").map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });
});

describe("GET /api/terragucci/file (#490)", () => {
  it("hands back a run's report page from the source, sandboxed", async () => {
    const key = "github.com/acme/shop/2026/10/d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2/tf-apply-wave-2/report.html";
    const res = await served().request(`/api/terragucci/file?key=${encodeURIComponent(key)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toContain("<html");
  });

  it.each(["../package.json", "github.com/../../etc/passwd.json", "/etc/hosts.txt", "index.js", ""])("refuses %j", async (key) => {
    expect((await served().request(`/api/terragucci/file?key=${encodeURIComponent(key)}`)).status).toBe(400);
  });

  it("answers 404 for a key the source does not hold", async () => {
    expect((await served().request("/api/terragucci/file?key=nope/report.json")).status).toBe(404);
  });
});
