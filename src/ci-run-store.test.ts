import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveDispatchedRun,
  readDispatchedRun,
  concludeDispatchedRun,
  clearDispatchedRun,
  dispatchedRunPath,
} from "./ci-run-store.ts";

describe("ci-run-store (#165 §6)", () => {
  let root: string;
  const project = "/estates/loomster";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "behold-ci-run-store-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const base = { projectDir: project, env: "prod", workflow: "deploy.yml", ref: "main", runId: 18234771902, dispatchedAt: "2026-09-01T20:00:00Z" };

  it("round-trips the adopted run, and a later save carries the url forward", () => {
    saveDispatchedRun(base, root);
    expect(readDispatchedRun(project, root)).toMatchObject({ version: 1, runId: 18234771902, env: "prod" });

    saveDispatchedRun({ ...base, url: "https://github.com/o/r/actions/runs/18234771902" }, root);
    expect(readDispatchedRun(project, root)?.url).toContain("/runs/18234771902");
  });

  it("concludes with the follow's verdict — and only for the run that is actually persisted", () => {
    saveDispatchedRun(base, root);
    concludeDispatchedRun(project, 999, "ok", root); // a different run — must not touch the record
    expect(readDispatchedRun(project, root)?.concluded).toBeUndefined();

    concludeDispatchedRun(project, base.runId, "lost", root);
    expect(readDispatchedRun(project, root)?.concluded?.verdict).toBe("lost");
  });

  it("a record is invisible to another project — the path is per-project and the content is sanity-checked", () => {
    saveDispatchedRun(base, root);
    expect(readDispatchedRun("/estates/other", root)).toBeUndefined();
    // Even a colliding path (hand-copied file) refuses another project's record.
    const copied = readFileSync(dispatchedRunPath(project, root), "utf8");
    writeFileSync(dispatchedRunPath("/estates/other", root), copied);
    expect(readDispatchedRun("/estates/other", root)).toBeUndefined();
  });

  it("absent, corrupt, and wrong-shape files all read as undefined — never a throw", () => {
    expect(readDispatchedRun(project, root)).toBeUndefined();
    writeFileSync(dispatchedRunPath(project, root), "not json");
    expect(readDispatchedRun(project, root)).toBeUndefined();
    writeFileSync(dispatchedRunPath(project, root), JSON.stringify({ version: 9, runId: "nope" }));
    expect(readDispatchedRun(project, root)).toBeUndefined();
  });

  it("clear drops the record", () => {
    saveDispatchedRun(base, root);
    clearDispatchedRun(project, root);
    expect(readDispatchedRun(project, root)).toBeUndefined();
  });
});
