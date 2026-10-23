// behold#749: under `serve --repos`, the terragucci reports' project follows
// the checkout `?repo=` names. The demo host's serve pinned one project with
// --terragucci-project while the kiosk frame switched `?repo=` per scenario,
// so a frame for fan-out-tofu drew fan-out-choudoufu's plan. The checkouts are
// cloned from the forge's published port (localhost:3300/<owner>/<name>) and
// the pipeline names its projects by the forge's own address
// (forgejo:3000/<owner>/<name>), so the match is by <owner>/<name>.
import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";

// The estate read needs chant's terraform lexicon and a real chant run: it answers the example's recorded IR, as in terragucci-route.test.ts.
vi.mock("./estate.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./estate.ts")>()),
  composeEstate: vi.fn(),
}));
import { composeEstate } from "./estate.ts";
import { createApp } from "./server.ts";
import { matchProject, pickProject, TerragucciReadError, type IndexRow } from "./terragucci-reports.ts";
import { terragucciSource } from "./terragucci-source.ts";
import { readTimeline } from "./terragucci-timeline.ts";

const HERE = import.meta.dirname;
const BUCKET = join(HERE, "..", "example-terragucci-reports");
const IR = (): GraphIR => ({ ...(JSON.parse(readFileSync(join(HERE, "__fixtures__", "terragucci-example-ir.json"), "utf8")) as GraphIR), edges: [], groups: {} });
const SHOP = "forgejo:3000/acme/shop";
const OTHER = "forgejo:3000/acme/other";

const parent = mkdtempSync(join(tmpdir(), "behold-tg-repos-project-"));
afterAll(() => rmSync(parent, { recursive: true, force: true }));

/** The example bucket with its project renamed to the forge's own address, and a second project beside it. */
function bucket(): string {
  const d = join(parent, "bucket");
  cpSync(BUCKET, d, { recursive: true });
  const index = JSON.parse(readFileSync(join(d, "index.json"), "utf8")) as { reports: IndexRow[] };
  const shop = index.reports.map((r) => ({ ...r, project: SHOP }));
  index.reports = [...shop, ...shop.map((r) => ({ ...r, project: OTHER }))];
  writeFileSync(join(d, "index.json"), JSON.stringify(index));
  return d;
}

/** A checkout of terragucci's example under `parent`, cloned from the forge's published port. */
function checkout(name: string): string {
  const dir = join(parent, name);
  for (const env of ["dev", "staging", "prod"]) {
    for (const svc of ["platform", "email", "orders", "payments", "search"]) {
      mkdirSync(join(dir, "envs", env, svc), { recursive: true });
      writeFileSync(join(dir, "envs", env, svc, "main.tf"), 'terraform {\n  required_version = "~> 1.13.0"\n}\n\nresource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n');
    }
  }
  writeFileSync(join(dir, "terragucci.yml"), "binary: tofu\n");
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", `http://localhost:3300/acme/${name}.git`]);
  return dir;
}

const source = bucket();
const shop = checkout("shop");
const other = checkout("other");
const none = checkout("none");
const repos = new Map([
  ["shop", { projectDir: shop, projectDirs: [shop] }],
  ["other", { projectDir: other, projectDirs: [other] }],
  ["none", { projectDir: none, projectDirs: [none] }],
]);

const app = (dir: string, opts: { project?: string; repos?: boolean } = {}) =>
  createApp({
    projectDir: dir,
    projectDirs: [dir],
    port: 0,
    public: true,
    terragucci: { source, ...(opts.project ? { project: opts.project } : {}) },
    ...(opts.repos ? { viewRepos: { parent, repos, defaultName: [...repos].find(([, t]) => t.projectDir === dir)![0] } } : {}),
  } as Parameters<typeof createApp>[0]);

const marks = async (a: ReturnType<typeof app>, q: string) => {
  const res = await a.request(`/api/terragucci${q}`);
  return { status: res.status, body: (await res.json()) as { project?: string; pull_request?: unknown; code?: string; error?: string } };
};

beforeEach(() => {
  vi.mocked(composeEstate).mockReset();
  vi.mocked(composeEstate).mockImplementation((async () => IR()) as never);
});

describe("matchProject (behold#749)", () => {
  it("takes the same <host>/<path>, else the one project with the same <owner>/<name>", () => {
    expect(matchProject([SHOP, OTHER], SHOP)).toBe(SHOP);
    expect(matchProject([SHOP, OTHER], "localhost:3300/acme/other")).toBe(OTHER);
    expect(matchProject([SHOP, OTHER], "localhost:3300/ACME/Shop")).toBe(SHOP);
    expect(matchProject([SHOP, OTHER], "localhost:3300/acme/none")).toBeUndefined();
    expect(matchProject([SHOP, OTHER], undefined)).toBeUndefined();
    // Two hosts with the same path name none: the owner and name don't decide.
    expect(matchProject([SHOP, "github.com/acme/shop"], "localhost:3300/acme/shop")).toBeUndefined();
  });

  it("picks the checkout's project by <owner>/<name> among several; a strict pick refuses one that isn't there, even when it's the only one", () => {
    const rows = [{ project: SHOP }, { project: OTHER }] as IndexRow[];
    const src = terragucciSource(source);
    expect(pickProject(rows, { checkoutProject: "localhost:3300/acme/other" }, src)).toBe(OTHER);
    expect(pickProject(rows, { strict: true, checkoutProject: "localhost:3300/acme/other" }, src)).toBe(OTHER);
    expect(() => pickProject([{ project: SHOP }] as IndexRow[], { strict: true, checkoutProject: "localhost:3300/acme/none" }, src)).toThrow(TerragucciReadError);
    // Not strict, the index's only project is the pick, as before.
    expect(pickProject([{ project: SHOP }] as IndexRow[], { checkoutProject: "localhost:3300/acme/none" }, src)).toBe(SHOP);
  });

  it("reads the timeline of the checkout's project, and none of another's when strict", async () => {
    const d = join(parent, "audit");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "audit.jsonl"), "");
    const t = await readTimeline(terragucciSource(d), { strict: true, checkoutProject: "localhost:3300/acme/none" });
    expect(t.entries).toEqual([]);
  });
});

describe("/api/terragucci under serve --repos with --terragucci-project (behold#749)", () => {
  const a = app(shop, { project: SHOP, repos: true });

  it("reads the pinned project for the serve's own checkout, with or without ?repo=", async () => {
    expect((await marks(a, "")).body.project).toBe(SHOP);
    expect((await marks(a, "?repo=shop")).body.project).toBe(SHOP);
    expect((await marks(a, "?repo=acme/shop")).body.project).toBe(SHOP);
  });

  it("reads another checkout's own project, matched by <owner>/<name>, not the pinned one", async () => {
    const r = await marks(a, "?repo=other");
    expect(r.status).toBe(200);
    expect(r.body.project).toBe(OTHER);
    expect(r.body.pull_request).toBeDefined();
    // The serve's own checkout still reads its pin after another's read.
    expect((await marks(a, "")).body.project).toBe(SHOP);
  });

  it("draws no plan for a checkout whose project the reports don't hold", async () => {
    const r = await marks(a, "?repo=none");
    expect(r.status).toBe(422);
    expect(r.body.pull_request).toBeUndefined();
    expect(r.body.error).toContain("localhost:3300/acme/none");
    const progress = await a.request("/api/terragucci/progress?repo=none");
    expect(progress.status).toBe(422);
  });

  it("tells /api/project the pinned project only for the serve's own checkout", async () => {
    const pinned = async (q: string) => ((await (await a.request(`/api/project${q}`)).json()) as { terragucciReports?: { project?: string } }).terragucciReports?.project;
    expect(await pinned("")).toBe(SHOP);
    expect(await pinned("?repo=other")).toBeUndefined();
  });
});

describe("a single-repo serve (behold#749)", () => {
  it("reads --terragucci-project as before", async () => {
    expect((await marks(app(other, { project: SHOP }), "")).body.project).toBe(SHOP);
  });

  it("picks the checkout's own project by <owner>/<name> when none is pinned", async () => {
    expect((await marks(app(other), "")).body.project).toBe(OTHER);
  });

  it("still asks which project when none matches the checkout", async () => {
    const r = await marks(app(none), "");
    expect(r.status).toBe(422);
    expect(r.body.error).toContain("lists 2 projects");
  });
});
