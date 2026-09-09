// #209: the demo catalog — the COMMITTED demos.json is validated here (an
// entry that doesn't load is a demo nobody can run), plus the loader's
// malformed-input behavior and the requirement checker.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDemoRegistry, missingRequirements, fetchesFromNetwork, demoTargetDir, demoLocalPath, loadDemo, type DemoEntry } from "./demos.ts";
import { choudoufuBinary } from "./choudoufu-member.ts";

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
    // #388: the workbench catalog is a checkout's, not the tarball's — an
    // entry naming `../choudoufu` means nothing inside an npm install.
    expect(files).not.toContain("workbench.json");
  });

  // #388: the committed workbench.json has to load — a typo there is a
  // catalog nobody in this repo can run — and its entries carry the catalog
  // they came from, which is what the two `--list` blocks and the panel group on.
  it("reads workbench.json beside demos.json, stamping every entry with its catalog", () => {
    expect(existsSync(join(REPO, "workbench.json"))).toBe(true);
    for (const e of registry) expect(e.catalog === "demos" || e.catalog === "workbench", e.name).toBe(true);
    expect(registry.filter((e) => e.catalog === "demos").map((e) => e.name)).toContain("writes");
    // Every workbench entry (M3 seeds them) is a local one, and names its
    // path relative to the file that listed it.
    for (const e of registry.filter((e) => e.catalog === "workbench")) {
      expect(e.source, e.name).toBe("local");
      expect(e.catalogDir, e.name).toBe(REPO);
    }
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

  // #372: a demo's spawn environment is a flat string map, or nothing; the
  // committed choudoufu-estate entry names the scratch emulator through it.
  it("a spawnEnv that is not a string map drops the entry; a well-formed one is carried", () => {
    const entry = (spawnEnv: unknown, name: string) => ({ name, description: "d", source: "bundled", dir: "x", requires: [], serve: { env: "live", spawnEnv } });
    const dir = tmpRoot(
      JSON.stringify({
        demos: [entry({ AWS_ENDPOINT_URL: "http://127.0.0.1:4650" }, "good"), entry(["AWS_ENDPOINT_URL=x"], "array"), entry({ PORT: 4650 }, "number"), entry("x", "string"), entry(undefined, "none")],
      }),
    );
    const got = loadDemoRegistry(dir);
    expect(got.map((e) => e.name)).toEqual(["good", "none"]);
    expect(got[0]!.serve.spawnEnv).toEqual({ AWS_ENDPOINT_URL: "http://127.0.0.1:4650" });
    rmSync(dir, { recursive: true, force: true });
    const shipped = loadDemoRegistry(REPO).find((e) => e.name === "choudoufu-estate")!;
    expect(shipped.requires).toEqual(["docker", "choudoufu"]);
    expect(shipped.serve).toMatchObject({ env: "live", dirs: ["monolith", "team-a", "team-b", "team-c"], spawnEnv: { AWS_ENDPOINT_URL: "http://127.0.0.1:4650" } });
    for (const d of shipped.serve.dirs!) expect(existsSync(join(REPO, shipped.dir!, d, "main.tf")), d).toBe(true);
  });

  // #388: the local source. A path, a path served in place, or no path at all
  // and a setup that renders one — anything else names nothing to serve.
  it("validates the local source: path, no path + setup, inPlace; and drops what names nothing", () => {
    const local = (over: Record<string, unknown>) => ({ description: "d", source: "local", requires: [], serve: {}, ...over });
    const dir = tmpRoot(
      JSON.stringify({
        demos: [
          local({ name: "path", path: "../choudoufu" }),
          local({ name: "generator", setup: "bash render.sh" }),
          local({ name: "in-place", path: "../chant", inPlace: true, description: "served where it sits; its setup writes nothing the repo does not gitignore" }),
          local({ name: "nothing" }),
          local({ name: "in-place-no-path", inPlace: true, setup: "x" }),
          local({ name: "path-not-string", path: 4 }),
          local({ name: "in-place-not-bool", path: "../x", inPlace: "yes" }),
        ],
      }),
    );
    expect(loadDemoRegistry(dir).map((e) => e.name)).toEqual(["path", "generator", "in-place"]);
    // A relative path resolves against the CATALOG file's directory, never the
    // cwd behold started in — the workbench names its siblings.
    const entry = loadDemoRegistry(dir).find((e) => e.name === "path")!;
    expect(demoLocalPath(entry)).toBe(join(dir, "..", "choudoufu"));
    expect(demoLocalPath({ ...entry, path: "/opt/estates/net" })).toBe("/opt/estates/net");
    expect(demoLocalPath(loadDemoRegistry(dir).find((e) => e.name === "generator")!)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  // #388: two files, one registry. A workbench name that collides with a
  // bundled one is dropped — `behold demo writes` means the same demo in every
  // checkout, and a silent override is how it would stop meaning it.
  it("merges workbench.json and BEHOLD_WORKBENCH, dropping collisions", () => {
    const dir = tmpRoot(JSON.stringify({ demos: [{ name: "writes", description: "the bundled one", source: "bundled", dir: "x", requires: [], serve: {} }] }));
    writeFileSync(
      join(dir, "workbench.json"),
      JSON.stringify({
        demos: [
          { name: "writes", description: "an impostor", source: "local", path: "../elsewhere", requires: [], serve: {} },
          { name: "terralith-4", description: "205 resources", source: "local", setup: "render.sh", requires: [], serve: {} },
        ],
      }),
    );
    const elsewhere = mkdtempSync(join(tmpdir(), "behold-workbench-"));
    writeFileSync(join(elsewhere, "extra.json"), JSON.stringify({ demos: [{ name: "waterpark", description: "the access roots", source: "local", path: "../waterpark", requires: [], serve: {} }] }));

    const before = loadDemoRegistry(dir);
    expect(before.map((e) => e.name)).toEqual(["writes", "terralith-4"]);
    expect(before.map((e) => e.catalog)).toEqual(["demos", "workbench"]);
    expect(before[0]!.description).toBe("the bundled one"); // the bundled entry wins the collision

    process.env.BEHOLD_WORKBENCH = join(elsewhere, "extra.json");
    try {
      const after = loadDemoRegistry(dir);
      expect(after.map((e) => e.name)).toEqual(["writes", "terralith-4", "waterpark"]);
      // The named file's own directory is what ITS entries resolve against.
      expect(demoLocalPath(after.find((e) => e.name === "waterpark")!)).toBe(join(elsewhere, "..", "waterpark"));
    } finally {
      delete process.env.BEHOLD_WORKBENCH;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
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

  // #388, the local source. Three shapes, one loader.
  const localEntry = (over: Partial<DemoEntry>): DemoEntry => ({ name: "wb", description: "d", source: "local", requires: [], serve: {}, ...over });

  /** A checkout to point a local entry at: a sibling of the catalog file. */
  const sibling = (name: string): { catalogDir: string; path: string } => {
    const catalogDir = scratch("behold-workbench-");
    const path = join(catalogDir, "..", name);
    mkdirSync(join(path, "src"), { recursive: true });
    mkdirSync(join(path, "node_modules", "left-behind"), { recursive: true });
    writeFileSync(join(path, "chant.config.ts"), "export default {};");
    roots.push(path);
    return { catalogDir, path };
  };

  it("copies a local entry into the target by default — it's yours, edit it", async () => {
    const { catalogDir, path } = sibling("choudoufu-copy");
    const target = join(scratch("behold-demos-target-"), "wb");
    const res = await loadDemo(localEntry({ path: `../choudoufu-copy`, catalogDir }), { pkgRoot: catalogDir, target });
    expect(res.ok && res.serveDirs).toEqual([target]);
    expect(existsSync(join(target, "chant.config.ts"))).toBe(true);
    expect(existsSync(join(target, "node_modules"))).toBe(false); // the bundled filter, unchanged
    expect(readFileSync(join(path, "chant.config.ts"), "utf8")).toBe("export default {};"); // the checkout is untouched
  });

  it("serves an inPlace entry where it sits — no copy, and dirs resolve under the path", async () => {
    const { catalogDir, path } = sibling("chant-in-place");
    mkdirSync(join(path, "examples", "one"), { recursive: true });
    const entry = localEntry({ path: "../chant-in-place", inPlace: true, catalogDir, serve: { dirs: ["examples/one"] } });
    const target = join(scratch("behold-demos-target-"), "wb");
    const res = await loadDemo(entry, { pkgRoot: catalogDir, target });
    expect(res.ok && res.serveDirs).toEqual([join(path, "examples", "one")]);
    expect(existsSync(target)).toBe(false); // nothing copied, nothing created
    // And `demoTargetDir` agrees: an in-place entry IS its path, so the panel
    // reads it as already loaded rather than offering a copy nobody serves.
    expect(demoTargetDir(entry)).toBe(join(path));
  });

  it("makes a generator entry's target and runs the setup in it, with the workbench env", async () => {
    const catalogDir = scratch("behold-workbench-");
    const target = join(scratch("behold-demos-target-"), "terralith-4");
    const res = await loadDemo(
      localEntry({
        name: "terralith-4",
        catalogDir,
        setup: 'printf "%s\\n%s\\n" "$BEHOLD_WORKBENCH_DIR" "$BEHOLD_DEMO_NAME" > rendered.txt && echo "estate = \\"t4\\"" > estate.chdf.hcl',
      }),
      { pkgRoot: catalogDir, target },
    );
    expect(res.ok && res.serveDirs).toEqual([target]);
    expect(readFileSync(join(target, "rendered.txt"), "utf8")).toBe(`${catalogDir}\nterralith-4\n`);
    expect(existsSync(join(target, "estate.chdf.hcl"))).toBe(true); // the setup rendered the estate
  });

  it("refuses an inPlace entry whose checkout is not there, rather than serving an empty directory", async () => {
    const catalogDir = scratch("behold-workbench-");
    const res = await loadDemo(localEntry({ path: "../not-checked-out", inPlace: true, catalogDir }), { pkgRoot: catalogDir, target: join(scratch("behold-demos-target-"), "wb") });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain("../not-checked-out");
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

  // #388: a sibling nobody checked out reads exactly like a missing binary —
  // the entry stays listed, disabled, saying what is absent, and CI (where no
  // sibling is checked out) stays clean.
  it("reports a local entry's unchecked-out path as missing, and says so in its own words", () => {
    const catalogDir = mkdtempSync(join(tmpdir(), "behold-workbench-"));
    const here = { name: "x", description: "", source: "local" as const, path: ".", requires: [], serve: {}, catalogDir };
    expect(missingRequirements(here)).toEqual([]);
    expect(missingRequirements({ ...here, path: "../nope" })).toEqual(["../nope (not checked out)"]);
    // A generator entry names no path, so there is nothing to be missing.
    expect(missingRequirements({ ...here, path: undefined, setup: "render.sh" })).toEqual([]);
    rmSync(catalogDir, { recursive: true, force: true });
  });

  // #388, decision 4: the binary behold spawns is CHOUDOUFU_BIN's when it
  // names one — the Homebrew release is below behold's floor, and the build
  // that carries the floor's fields is one somebody left outside PATH.
  it("CHOUDOUFU_BIN satisfies the choudoufu requirement, and is the binary the helper names", () => {
    const entry = { name: "x", description: "", source: "bundled" as const, dir: "x", requires: ["choudoufu"], serve: {} };
    const before = process.env.CHOUDOUFU_BIN;
    try {
      delete process.env.CHOUDOUFU_BIN;
      expect(choudoufuBinary()).toBe("choudoufu");
      process.env.CHOUDOUFU_BIN = process.execPath; // an existing file, which is all the check asks
      expect(choudoufuBinary()).toBe(process.execPath);
      expect(missingRequirements(entry)).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.CHOUDOUFU_BIN;
      else process.env.CHOUDOUFU_BIN = before;
    }
  });
});
