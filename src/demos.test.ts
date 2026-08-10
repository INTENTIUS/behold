// #209: the demo catalog — the COMMITTED demos.json is validated here (an
// entry that doesn't load is a demo nobody can run), plus the loader's
// malformed-input behavior and the requirement checker.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDemoRegistry, missingRequirements, fetchesFromNetwork, demoTargetDir, loadDemo, type DemoEntry } from "./demos.ts";

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

  // #254: the walkthrough is a catalog entry like any other, and every path it
  // names has to exist in the directory that gets copied — a typo here is a
  // demo that boots to an Emit button with nowhere to write.
  it("the carve entry names four real paths inside the bundled estate", () => {
    const carve = registry.find((e) => e.name === "carve");
    expect(carve, "no carve entry in demos.json").toBeTruthy();
    expect(carve!.requires).toEqual([]); // offline tier: no Docker, no terraform
    const c = carve!.serve.carve!;
    expect(c).toBeTruthy();
    for (const p of [c.report, c.from, c.state!, c.project, c.out]) {
      expect(p.startsWith("/"), `${p} must be relative to the copy`).toBe(false);
    }
    for (const p of [c.report, c.from, c.state!, c.project]) {
      expect(existsSync(join(REPO, carve!.dir!, p)), `${p} missing from ${carve!.dir}`).toBe(true);
    }
    // The emitted source imports the project's lexicon and Node resolves that
    // from the file's own directory upward — an output dir outside the project
    // would never lint. `out` is generated, so it is not expected to exist yet.
    expect(`${c.out}/`.startsWith(`${c.project}/`)).toBe(true);
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

  it("a half-wired carve entry drops rather than serving a walkthrough that can't act (#254)", () => {
    const carve = (c: unknown) => ({ name: "c", description: "d", source: "bundled", dir: "x", requires: [], serve: { carve: c } });
    const good = { report: "r.json", from: "tf", state: "tf/s.tfstate", project: "app", out: "app/carveout" };
    const dir = tmpRoot(
      JSON.stringify({
        demos: [
          { ...carve(good), name: "good" },
          { ...carve({ ...good, out: undefined }), name: "no-out" },
          { ...carve({ ...good, from: "/etc" }), name: "absolute" },
          { ...carve({ ...good, report: "../../secrets.json" }), name: "escapes" },
          { ...carve({ ...good, out: "elsewhere/carveout" }), name: "out-outside-project" },
        ],
      }),
    );
    expect(loadDemoRegistry(dir).map((e) => e.name)).toEqual(["good"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("loadDemo — the copy/install/setup the CLI and the route share (#268)", () => {
  const roots: string[] = [];
  const scratch = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
  };
  afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

  const bundledEntry = (over: Partial<DemoEntry> = {}): DemoEntry => ({
    name: "sample",
    description: "d",
    source: "bundled",
    dir: "example-sample",
    requires: [],
    serve: {},
    ...over,
  });

  /** A package root holding one bundled example — sources, and a node_modules
   * that must NOT come along. */
  const pkgRootWithExample = () => {
    const root = scratch("behold-demos-pkg-");
    const example = join(root, "example-sample");
    mkdirSync(join(example, "src"), { recursive: true });
    mkdirSync(join(example, "node_modules", "left-behind"), { recursive: true });
    writeFileSync(join(example, "chant.config.ts"), "export default {};");
    writeFileSync(join(example, "src", "estate.ts"), "// estate");
    writeFileSync(join(example, "node_modules", "left-behind", "index.js"), "throw new Error('copied!')");
    return root;
  };

  it("copies a bundled example out of the package, node_modules excluded", async () => {
    const pkgRoot = pkgRootWithExample();
    const target = join(scratch("behold-demos-target-"), "sample");
    const res = await loadDemo(bundledEntry(), { pkgRoot, target });

    expect(res.ok).toBe(true);
    expect(existsSync(join(target, "chant.config.ts"))).toBe(true);
    expect(existsSync(join(target, "src", "estate.ts"))).toBe(true);
    expect(existsSync(join(target, "node_modules"))).toBe(false);
    expect(res.ok && res.serveDirs).toEqual([target]);
  });

  it("reuses an existing target instead of copying over it — a second load just starts the demo again", async () => {
    const pkgRoot = pkgRootWithExample();
    const target = join(scratch("behold-demos-target-"), "sample");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "chant.config.ts"), "// EDITED BY THE OPERATOR");
    const lines: string[] = [];
    const res = await loadDemo(bundledEntry(), { pkgRoot, target, log: (l) => lines.push(l) });

    expect(res.ok).toBe(true);
    expect(readFileSync(join(target, "chant.config.ts"), "utf8")).toContain("EDITED BY THE OPERATOR");
    expect(lines.join("\n")).toContain("reusing");
  });

  it("#211: an estate entry's serveDirs are its members, primary first", async () => {
    const pkgRoot = pkgRootWithExample();
    const target = join(scratch("behold-demos-target-"), "sample");
    const res = await loadDemo(bundledEntry({ serve: { dirs: ["control-plane", "app-a"] } }), { pkgRoot, target });
    expect(res.ok && res.serveDirs).toEqual([join(target, "control-plane"), join(target, "app-a")]);
  });

  it("a missing bundled dir is an error, not a throw and not a process exit", async () => {
    const res = await loadDemo(bundledEntry({ dir: "example-absent" }), {
      pkgRoot: scratch("behold-demos-empty-"),
      target: join(scratch("behold-demos-target-"), "sample"),
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain("example-absent");
  });

  it("a failing setup stops the load and says which command failed", async () => {
    const pkgRoot = pkgRootWithExample();
    const target = join(scratch("behold-demos-target-"), "sample");
    const res = await loadDemo(bundledEntry({ setup: "exit 3" }), { pkgRoot, target });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain("exit 3");
  });
});

describe("demoTargetDir", () => {
  it("puts a demo under behold-demos/<name>, absolute", () => {
    const cwd = mkdtempSync(join(tmpdir(), "behold-demos-cwd-"));
    const entry: DemoEntry = { name: "k8s", description: "", source: "bundled", dir: "x", requires: [], serve: {} };
    expect(demoTargetDir(entry, cwd)).toBe(join(cwd, "behold-demos", "k8s"));
    rmSync(cwd, { recursive: true, force: true });
  });

  it("keeps the pre-catalog ./behold-demo copy for the writes demo when one exists (#193)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "behold-demos-cwd-"));
    const writes: DemoEntry = { name: "writes", description: "", source: "bundled", dir: "x", requires: [], serve: {} };
    expect(demoTargetDir(writes, cwd)).toBe(join(cwd, "behold-demos", "writes"));
    mkdirSync(join(cwd, "behold-demo"));
    expect(demoTargetDir(writes, cwd)).toBe(join(cwd, "behold-demo"));
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("fetchesFromNetwork", () => {
  it("is the git entries and only the git entries — the flag the panel's button reads", () => {
    const registry = loadDemoRegistry(REPO);
    expect(registry.filter(fetchesFromNetwork).map((e) => e.name)).toEqual(registry.filter((e) => e.source === "git").map((e) => e.name));
    expect(registry.filter(fetchesFromNetwork).length).toBeGreaterThan(0); // fountain (#210)
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
