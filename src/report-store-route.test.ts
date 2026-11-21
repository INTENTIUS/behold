/**
 * behold#1228: scenarios over the server's routes. A plywood repo served with
 * its reports bucket shows its estate, waiting waves and timeline; a SQL
 * Yodeler repo in its current format still shows its report and its audit
 * record. The one seam mocked is the graph read, as in terragucci-route.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";

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
const PLYWOOD = join(HERE, "__fixtures__", "plywood-reports");
const YODEL_REPORT = join(HERE, "__fixtures__", "yodel-report", "good");
const YODEL_AUDIT = join(HERE, "__fixtures__", "sql-yodeler-audit.jsonl");

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function repo(name: string, files: Record<string, string>): string {
  const top = mkdtempSync(join(tmpdir(), "behold-store-route-"));
  made.push(top);
  const dir = join(top, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  return dir;
}
function served(dir: string, cfg: { terragucci?: { source: string }; yodelReport?: string }) {
  const broadcaster = new Broadcaster();
  return createApp({ projectDir: dir, projectDirs: [dir], port: 0, ...cfg }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
}

beforeEach(() => {
  vi.mocked(composeEstate).mockReset();
  vi.mocked(composeEstate).mockImplementation((async () => ({ nodes: [], edges: [], groups: {} }) as unknown as GraphIR) as never);
});

describe("a plywood repo served with its reports bucket (behold#1228)", () => {
  const dir = () => repo("shop-infra", { "plywood.yml": "reports:\n  bucket: file:///reports\n" });

  it("GET /api/terragucci answers the estate and its waiting wave from chant's estate", async () => {
    const res = await served(dir(), { terragucci: { source: PLYWOOD } }).request("/api/terragucci");
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j).toMatchObject({ product: "plywood", members: ["network", "web"], estate: { waiting: 1, html: "estate/estate.html" }, validation: { by: "chant" } });
    expect(j.waiting).toEqual([expect.objectContaining({ project: "web", wave: 1, gate: "wave-1" })]);
    expect((j.recent as unknown[]).length).toBeGreaterThan(0);
  });

  it("reads the bucket by a file:// address too, and opens its estate page through the file route", async () => {
    const app = served(dir(), { terragucci: { source: `file://${PLYWOOD}` } });
    expect((await app.request("/api/terragucci")).status).toBe(200);
    const page = await app.request("/api/terragucci/file?key=estate/estate.html");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<html");
  });

  it("GET /api/terragucci/timeline answers the audit record in chant's words", async () => {
    const res = await served(dir(), { terragucci: { source: PLYWOOD } }).request("/api/terragucci/timeline");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { record: { present: boolean }; total: number; entries: { kind: string; product: string }[] };
    expect(j.record.present).toBe(true);
    expect(j.total).toBe(5);
    expect(j.entries.map((e) => e.kind)).toEqual(["revoked", "override-recorded", "applied", "approved", "approval-requested"]);
  });
});

describe("a SQL Yodeler repo in its current format (behold#1228)", () => {
  const dir = () => repo("shop-db", { "yodel.config.ts": "export default {};\n" });

  it("GET /api/yodel-report reads its report and drift, the audit entries in SQL Yodeler's words", async () => {
    const res = await served(dir(), { yodelReport: YODEL_REPORT }).request("/api/yodel-report");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { validation: { by: string }; audit: { kind: string; environment: string }[] };
    expect(j.validation.by).toBe("chant");
    expect(j.audit).toEqual([expect.objectContaining({ kind: "applied", environment: "prod" })]);
  });

  it("GET /api/terragucci/timeline reads its own audit.jsonl from the bucket", async () => {
    const bucket = mkdtempSync(join(tmpdir(), "behold-store-route-yodel-"));
    made.push(bucket);
    cpSync(YODEL_AUDIT, join(bucket, "audit.jsonl"));
    const res = await served(dir(), { terragucci: { source: bucket } }).request("/api/terragucci/timeline");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { total: number; entries: { product: string; environment: string }[] };
    expect(j.total).toBe(13);
    expect(j.entries.every((e) => e.product === "sql-yodeler" && e.environment)).toBe(true);
  });
});
