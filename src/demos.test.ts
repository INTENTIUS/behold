// #209: the demo catalog — the COMMITTED demos.json is validated here (an
// entry that doesn't load is a demo nobody can run), plus the loader's
// malformed-input behavior and the requirement checker.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDemoRegistry, missingRequirements } from "./demos.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("demos.json — the committed catalog (#209)", () => {
  const registry = loadDemoRegistry(REPO);

  it("loads, with unique names and a writes default", () => {
    expect(registry.length).toBeGreaterThanOrEqual(2);
    expect(new Set(registry.map((e) => e.name)).size).toBe(registry.length);
    expect(registry.some((e) => e.name === "writes")).toBe(true);
  });

  it("every bundled entry's dir exists in the repo (and must be in package.json files)", () => {
    const files = (JSON.parse(require("node:fs").readFileSync(join(REPO, "package.json"), "utf8")) as { files: string[] }).files;
    for (const e of registry.filter((e) => e.source === "bundled")) {
      expect(existsSync(join(REPO, e.dir!)), `${e.name}: ${e.dir} missing`).toBe(true);
      expect(files, `${e.name}: ${e.dir} not shipped`).toContain(e.dir!);
    }
    expect(files).toContain("demos.json");
  });
});

describe("loadDemoRegistry — malformed input degrades, never throws", () => {
  const tmpRoot = (json: string) => {
    const dir = mkdtempSync(join(tmpdir(), "behold-demos-"));
    writeFileSync(join(dir, "demos.json"), json);
    return dir;
  };

  it("missing file → empty catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "behold-demos-none-"));
    expect(loadDemoRegistry(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("corrupt JSON → empty catalog", () => {
    const dir = tmpRoot("not json{");
    expect(loadDemoRegistry(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a malformed entry drops; well-formed neighbours survive", () => {
    const dir = tmpRoot(
      JSON.stringify({
        demos: [
          { name: "ok", description: "d", source: "bundled", dir: "x", requires: [], serve: {} },
          { name: "no-dir", description: "d", source: "bundled", requires: [], serve: {} },
          { name: "bad-source", description: "d", source: "ftp", requires: [], serve: {} },
          { name: "git-ok", description: "d", source: "git", repo: "https://x/y", requires: [], serve: {} },
        ],
      }),
    );
    expect(loadDemoRegistry(dir).map((e) => e.name)).toEqual(["ok", "git-ok"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("missingRequirements", () => {
  it("a present binary is not missing; a nonsense one is", () => {
    const entry = { name: "x", description: "", source: "bundled" as const, dir: "x", requires: ["node", "behold-no-such-binary-xyz"], serve: {} };
    expect(missingRequirements(entry)).toEqual(["behold-no-such-binary-xyz"]);
  });

  it("git entries implicitly require git", () => {
    const entry = { name: "x", description: "", source: "git" as const, repo: "https://x/y", requires: [], serve: {} };
    expect(missingRequirements(entry)).toEqual([]); // git is installed here
  });
});
