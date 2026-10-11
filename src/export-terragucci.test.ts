import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { createHash } from "node:crypto";
import { S3Error } from "./s3-object.ts";

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

describe("export --publish (#491)", () => {
  it("writes only under a views/<name> directory", async () => {
    const { publishTarget } = await import("./export.ts");
    expect(publishTarget("s3://acme/reports/views/behold")).toEqual({ bucket: "acme", prefix: "reports/views/behold" });
    expect(publishTarget("s3://acme/views/behold/")).toEqual({ bucket: "acme", prefix: "views/behold" });
    expect(publishTarget("s3://acme/reports")).toMatchObject({ error: expect.stringContaining("s3://acme/reports/views/behold") });
    expect(publishTarget("s3://acme/reports/views")).toHaveProperty("error");
    expect(publishTarget("s3://acme/reports/views/behold/extra")).toHaveProperty("error");
    expect(publishTarget("s3://acme/../views/behold")).toHaveProperty("error");
    expect(publishTarget("./out")).toHaveProperty("error");
  });

  /** A fake bucket: what was put, in order, with its headers, what was deleted, and the objects it holds. */
  function fakeBucket(objects: Record<string, string> = {}, opts: { deny?: boolean } = {}) {
    const put: { key: string; type: string; cache: string | undefined }[] = [];
    const deleted: string[] = [];
    const got: string[] = [];
    const client = {
      get: async (k: string) => {
        got.push(k);
        return objects[k];
      },
      put: async (k: string, _b: unknown, type: string, cache?: string) => {
        put.push({ key: k, type, cache });
      },
      delete: async (k: string) => {
        if (opts.deny) throw new S3Error(`DELETE s3://acme/${k}: 403 <Error><Code>AccessDenied</Code></Error>`, { status: 403, body: "<Error><Code>AccessDenied</Code></Error>" });
        deleted.push(k);
      },
    };
    return { client, put, deleted, got };
  }

  function bundle(): string {
    const dir = mkdtempSync(join(tmpdir(), "behold-publish-"));
    made.push(dir);
    mkdirSync(join(dir, "snapshots"));
    mkdirSync(join(dir, "icons", "k8s"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html>");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ keyToFile: { "/api/terragucci": "snapshots/api_terragucci.0123456789abcdef.json" } }));
    writeFileSync(join(dir, "app.js"), "export {}");
    writeFileSync(join(dir, "snapshots", "api_terragucci.0123456789abcdef.json"), "{}");
    writeFileSync(join(dir, "icons", "k8s", "pod.svg"), "<svg/>");
    writeFileSync(join(dir, "LICENSE"), "Apache");
    return dir;
  }
  const P = "reports/views/behold";

  it("uploads every file with its content type, the manifest after the snapshots and index.html last, cached by whether the name carries its hash (#500)", async () => {
    const { publishBundle, IMMUTABLE, NO_CACHE } = await import("./export.ts");
    const b = fakeBucket();
    const done = await publishBundle(bundle(), { bucket: "acme", prefix: P }, b.client as never);
    expect(done).toEqual({ files: 6, removed: [], warnings: [] });
    expect(b.got).toEqual([`${P}/manifest.json`]);
    expect(b.put.map((p) => [p.key.slice(P.length + 1), p.type, p.cache])).toEqual([
      ["LICENSE", "text/plain; charset=utf-8", NO_CACHE],
      ["app.js", "text/javascript; charset=utf-8", NO_CACHE],
      ["icons/k8s/pod.svg", "image/svg+xml", NO_CACHE],
      ["snapshots/api_terragucci.0123456789abcdef.json", "application/json", IMMUTABLE],
      ["manifest.json", "application/json", NO_CACHE],
      ["index.html", "text/html; charset=utf-8", NO_CACHE],
    ]);
    expect(IMMUTABLE).toBe("public, max-age=31536000, immutable");
    expect(NO_CACHE).toBe("no-cache");
  });

  it("deletes, after index.html, the snapshots the previous manifest named and this export did not write, only under the prefix (#500)", async () => {
    const { publishBundle } = await import("./export.ts");
    const previous = {
      keyToFile: {
        "/api/terragucci": "snapshots/api_terragucci.0123456789abcdef.json", // written again: kept
        "/api/project": "snapshots/api_project.fedcba9876543210.json", // stale: removed
        "/api/graph": "snapshots/api_graph.json", // a 0.23.0 name: removed
        "/x": "../../index.html", // outside the prefix: never touched
        "/y": "snapshots/../../estate.html",
        "/z": "manifest.json",
      },
    };
    const b = fakeBucket({ [`${P}/manifest.json`]: JSON.stringify(previous) });
    const order: string[] = [];
    const client = {
      get: b.client.get,
      put: async (k: string, body: unknown, t: string, c?: string) => {
        order.push(`put ${k}`);
        await b.client.put(k, body, t, c);
      },
      delete: async (k: string) => {
        order.push(`delete ${k}`);
        await b.client.delete(k);
      },
    };
    const done = await publishBundle(bundle(), { bucket: "acme", prefix: P }, client as never);
    expect(b.deleted).toEqual([`${P}/snapshots/api_project.fedcba9876543210.json`, `${P}/snapshots/api_graph.json`]);
    expect(done.removed).toEqual(b.deleted);
    expect(done.warnings).toEqual([]);
    // Every delete comes after the new index.html.
    expect(order.indexOf(`put ${P}/index.html`)).toBeLessThan(order.findIndex((o) => o.startsWith("delete ")));
  });

  it("publishes anyway when the credentials cannot delete, and names s3:DeleteObject (#500)", async () => {
    const { publishBundle } = await import("./export.ts");
    const b = fakeBucket({ [`${P}/manifest.json`]: JSON.stringify({ keyToFile: { "/a": "snapshots/a.0000000000000000.json", "/b": "snapshots/b.1111111111111111.json" } }) }, { deny: true });
    const done = await publishBundle(bundle(), { bucket: "acme", prefix: P }, b.client as never);
    expect(done.files).toBe(6);
    expect(done.removed).toEqual([]);
    expect(done.warnings).toHaveLength(1);
    expect(done.warnings[0]).toContain("s3:DeleteObject");
    expect(b.put.at(-1)!.key).toBe(`${P}/index.html`);
  });

  it("publishes anyway when the previous manifest cannot be read, and leaves its files", async () => {
    const { publishBundle } = await import("./export.ts");
    const b = fakeBucket();
    const client = { ...b.client, get: async () => Promise.reject(new S3Error("GET: 403", { status: 403, body: "<Error><Code>AccessDenied</Code></Error>" })) };
    const done = await publishBundle(bundle(), { bucket: "acme", prefix: P }, client as never);
    expect(done.files).toBe(6);
    expect(b.deleted).toEqual([]);
    expect(done.warnings[0]).toContain("previous manifest.json could not be read");
  });
});

describe("snapshot names carry their content hash (#500)", () => {
  it("names every snapshot in the manifest by its bytes", { timeout: 60_000 }, async () => {
    const { CONTENT_ADDRESSED, bundleFiles } = await import("./export.ts");
    vi.mocked(composeEstate).mockImplementation((async () => IR()) as never);
    const dir = checkout();
    const out = join(mkdtempSync(join(tmpdir(), "behold-tg-view-")), "bundle");
    made.push(dirname(out));
    await quiet(() => runExport({ projectDir: dir, projectDirs: [dir], port: 0, terragucci: { source: BUCKET } }, out));
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { keyToFile: Record<string, string>; files: string[] };
    // #510: and every file of the bundle but itself, so a pruned commit is deleted without a list call.
    expect(manifest.files).toEqual(bundleFiles(out).filter((f) => f !== "manifest.json"));
    expect(manifest.files).toEqual(expect.arrayContaining(["index.html", "app.js", "history-picker.js", ...Object.values(manifest.keyToFile)]));
    const files = Object.values(manifest.keyToFile);
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      expect(f).toMatch(CONTENT_ADDRESSED);
      const hash = createHash("sha256").update(readFileSync(join(out, f), "utf8")).digest("hex").slice(0, 16);
      expect(f.endsWith(`.${hash}.json`)).toBe(true);
    }
  });
});
