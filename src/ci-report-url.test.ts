import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHANT_FLOORS, CI_REPORT_URL_CHANT_FLOOR, floorFor } from "./chant-floors.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { createApp } from "./server.ts";
import { declaredReportUrl, workspaceFromLs } from "./workspace.ts";
import type { WorkspaceDocument } from "./workspace-reader.ts";
import { DECLARED_REPORT_URL } from "./ci-report-url-fixture.ts";

// #818: the declaration's CI report URL (chant#4160). ls.json is what a local
// pack of chant main at 7f1bd9130 (chant PR #4164, labelled 0.124.32, the
// release that will carry it) printed for `chant workspace ls --json` in the
// workspace src/ci-report-url-fixture.ts makes with ci.reportUrl set to
// DECLARED_REPORT_URL.

const FIX = join(import.meta.dirname, "__fixtures__", "ci-report-url");
const ls = (): WorkspaceDocument => JSON.parse(readFileSync(join(FIX, "ls.json"), "utf8")) as WorkspaceDocument;
const REPORTS = join(import.meta.dirname, "__fixtures__", "chant-demo", "reports");

describe("the declared CI report URL, from workspace ls (#818)", () => {
  it("has its floor in the registry at 0.124.32, so doctor lists it", () => {
    expect(CI_REPORT_URL_CHANT_FLOOR).toBe("0.124.32");
    expect(CHANT_FLOORS).toContain(floorFor("declared CI report URL"));
  });
  it("reads ci.reportUrl from the recorded listing onto the workspace", () => {
    expect(ls().ci).toEqual({ green: null, reportUrl: DECLARED_REPORT_URL });
    const read = workspaceFromLs(ls(), "/acme");
    expect(read.ok && read.workspace.ciReportUrl).toBe(DECLARED_REPORT_URL);
  });
  it("reads nothing when none is declared, below the floor, or for a scheme chant doesn't take there", () => {
    const { reportUrl: _r, ...ci } = ls().ci as Record<string, unknown>;
    for (const doc of [{ ...ls(), ci }, { ...ls(), ci: null }, { ...ls(), ci: undefined }, { ...ls(), chant: "0.124.31" }, { ...ls(), ci: { green: null, reportUrl: "https://ci.example/reports" } }]) {
      expect(declaredReportUrl(doc)).toBeUndefined();
      const read = workspaceFromLs(doc, "/acme");
      expect(read.ok && "ciReportUrl" in read.workspace).toBe(false);
    }
    expect(declaredReportUrl({ ...ls(), ci: { green: null, reportUrl: `file://${REPORTS}` } })).toBe(`file://${REPORTS}`);
  });
});

describe("serve reads the declared URL when --ci-report-url isn't given (#818)", () => {
  const app = (cfg: { ciReportUrl?: string; ciReportUrlDeclared?: string }) => {
    const broadcaster = new Broadcaster();
    return createApp({ projectDir: FIX, port: 0, ...cfg }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: FIX, broadcaster, onDone: () => {} }));
  };
  it("serves the runs from the declared URL and says so", async () => {
    const r = await app({ ciReportUrlDeclared: `file://${REPORTS}` }).request("/api/chant/ci/runs");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { urlFrom: string; doc: { runs: unknown[] } };
    expect(body.urlFrom).toBe("declaration");
    expect(body.doc.runs).toHaveLength(5);
  });
  it("lets the flag override it", async () => {
    const body = (await (await app({ ciReportUrl: REPORTS, ciReportUrlDeclared: "file:///nowhere/at/all" }).request("/api/chant/ci/runs")).json()) as { urlFrom: string; source: string };
    expect(body).toMatchObject({ urlFrom: "flag", source: REPORTS });
  });
  it("has no chant run index route, and tags no kiosk page, with neither", async () => {
    const a = app({});
    expect((await a.request("/api/chant/ci/runs")).status).toBe(404);
    expect(await (await a.request("/kiosk")).text()).not.toContain("kiosk-runs");
  });
});
