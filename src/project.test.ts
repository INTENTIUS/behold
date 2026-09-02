import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { detectProject, detectProjectShape, loadBeholdConfig, readExecutor, executorDesignation, resetExecutorCache } from "./project.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function tmpProject(config: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-project-"));
  if (config !== null) writeFileSync(join(dir, "chant.config.ts"), config);
  return dir;
}

/** A tmp project root with (or without) a `.behold.json` — #70's tier config,
 * kept separate from `chant.config.ts` (tmpProject, above). `raw`, when given,
 * is written as-is, so a test can also cover malformed JSON / a malformed
 * `tiers` shape, not just the happy path. */
function tmpBeholdConfig(raw: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-config-"));
  if (raw !== null) writeFileSync(join(dir, ".behold.json"), raw);
  return dir;
}

describe("detectProject", () => {
  let dirs: string[] = [];
  beforeAll(() => (dirs = []));
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const make = (config: string | null) => {
    const d = tmpProject(config);
    dirs.push(d);
    return d;
  };

  it("reads declared environments, lexicons, and sourceDir from a literal config", async () => {
    const dir = make(
      `export default { lexicons: ["aws", "k8s"], environments: ["prod", "staging"], sourceDir: "src" };`,
    );
    expect(await detectProject(dir)).toEqual({
      environments: ["prod", "staging"],
      lexicons: ["aws", "k8s"],
      sourceDir: "src",
    });
  });

  // An environments entry may be chant's `{ name, endpoint }` object form (the
  // emulator binding, per chant's Config File docs). cc-aws-canonical declares
  // exactly that, and served with an empty env picker before this.
  it("reads the name out of an object-form environments entry", async () => {
    const dir = make(
      `export default { lexicons: ["aws", "k8s"], environments: [{ name: "local", endpoint: "http://localhost:4566" }, "prod"] };`,
    );
    expect((await detectProject(dir)).environments).toEqual(["local", "prod"]);
  });

  it("never mistakes an endpoint URL for an environment in the text-parse fallback", async () => {
    // A config the import path cannot evaluate (top-level await) forces the
    // regex fallback; the object entry must still yield its name, not its URL.
    const dir = make(
      `const x = await Promise.resolve(1);\nexport default { lexicons: ["aws"], environments: [{ name: "local", endpoint: "http://localhost:4566" }] };`,
    );
    expect((await detectProject(dir)).environments).toEqual(["local"]);
  });

  // #71: graphPath() honors a non-`src/` sourceDir — this locks in that
  // detectProject surfaces it (any legal directory name, not just "src").
  it("reads a non-src sourceDir from a literal config", async () => {
    const dir = make(`export default { lexicons: ["aws"], sourceDir: "infra" };`);
    expect((await detectProject(dir)).sourceDir).toBe("infra");
  });

  it("reads stacks[] from a literal config", async () => {
    const dir = make(
      `export default { lexicons: ["aws"], stacks: [{ name: "api", src: "stacks/api" }, { name: "web", src: "stacks/web" }] };`,
    );
    expect((await detectProject(dir)).stacks).toEqual([
      { name: "api", src: "stacks/api" },
      { name: "web", src: "stacks/web" },
    ]);
  });

  it("falls back to a text-parsed sourceDir when the config can't be imported (e.g. a missing dep)", async () => {
    const dir = make(
      `import "a-package-that-does-not-exist";\nexport default { lexicons: ["aws"], sourceDir: "infra" };`,
    );
    expect((await detectProject(dir)).sourceDir).toBe("infra");
  });

  it("handles multiline / single-quoted arrays", async () => {
    const dir = make(`export default {\n  lexicons: ['aws'],\n  environments: [\n    'prod',\n    'dev',\n  ],\n};`);
    expect((await detectProject(dir)).environments).toEqual(["prod", "dev"]);
  });

  it("reads environments through a defineConfig-style wrapper / satisfies", async () => {
    // The text parser also catches this, but it proves the shape is handled.
    const dir = make(
      `const identity = (c) => c;\nexport default identity({ lexicons: ["gcp"], environments: ["prod"] });`,
    );
    expect((await detectProject(dir)).environments).toEqual(["prod"]);
  });

  // #191: a pure-k8s project binds clusters through k8s.profiles and declares
  // no environments array at all — the profile keys are the env list.
  it("infers environments from k8s.profiles keys when environments is absent (importable config)", async () => {
    const dir = make(
      `export default { lexicons: ["k8s"], k8s: { profiles: { home: { context: "home-cloud" }, prod: { context: "prod-cloud" } } } };`,
    );
    const info = await detectProject(dir);
    expect(info.environments).toEqual(["home", "prod"]);
    expect(info.k8sProfiles).toEqual({ home: { context: "home-cloud" }, prod: { context: "prod-cloud" } });
  });

  it("an explicit environments list always wins over profile inference", async () => {
    const dir = make(
      `export default { lexicons: ["k8s"], environments: ["staging"], k8s: { profiles: { home: { context: "home-cloud" } } } };`,
    );
    expect((await detectProject(dir)).environments).toEqual(["staging"]);
  });

  it("infers profile-key environments in the text-parse fallback too (unimportable config)", async () => {
    // `satisfies ChantConfig` + the import make this config unimportable in a
    // project with no deps installed — the real shape #191 reported, verbatim.
    const dir = make(
      `import type { ChantConfig, K8sChantConfig } from "@intentius/chant";\n` +
        `export default {\n` +
        `  lexicons: ["k8s"],\n` +
        `  ownership: { stack: "ntfy" },\n` +
        `  k8s: { profiles: { home: { context: "home-cloud" } } } satisfies K8sChantConfig,\n` +
        `} satisfies ChantConfig;`,
    );
    const info = await detectProject(dir);
    expect(info.environments).toEqual(["home"]);
    expect(info.lexicons).toEqual(["k8s"]);
  });

  it("returns empty arrays when a field is absent", async () => {
    const dir = make(`export default { lexicons: ["aws"] };`);
    expect(await detectProject(dir)).toEqual({ environments: [], lexicons: ["aws"] });
  });

  it("returns empty when the field is computed, not a literal array", async () => {
    const dir = make(`const envs = globalThis.__nope__ || []; export default { lexicons: ["aws"], environments: envs };`);
    expect((await detectProject(dir)).environments).toEqual([]);
  });

  it("returns empty for a project with no config", async () => {
    expect(await detectProject(make(null))).toEqual({ environments: [], lexicons: [] });
  });

  // The committed fixture (e2e/fixtures/multi-stack, #76) — a real, durable
  // two-stack project on disk, distinct from the inline temp-dir configs above.
  it("reads both stacks from the committed e2e/fixtures/multi-stack fixture", async () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "e2e", "fixtures", "multi-stack");
    const info = await detectProject(fixture);
    expect(info.stacks).toEqual([
      { name: "api", src: "stacks/api" },
      { name: "web", src: "stacks/web" },
    ]);
  });
});

// #70: tiers are a separate, behold-owned `.behold.json` in the project root
// — not `chant.config.ts` — so a chant project that never opts in gets no
// tier axis at all (no picker, graph loads with no tier selected).
describe("loadBeholdConfig", () => {
  let dirs: string[] = [];
  beforeAll(() => (dirs = []));
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const make = (raw: string | null) => {
    const d = tmpBeholdConfig(raw);
    dirs.push(d);
    return d;
  };

  it("reads the pinned schema — envVar + values", () => {
    const dir = make(
      JSON.stringify({ tiers: { envVar: "LOOM_TIER", values: ["light", "production", "production-ha"] } }),
    );
    expect(loadBeholdConfig(dir)).toEqual({
      tiers: { envVar: "LOOM_TIER", values: ["light", "production", "production-ha"] },
    });
  });

  it("returns {} — no tier axis — when the file is absent", () => {
    expect(loadBeholdConfig(make(null))).toEqual({});
  });

  it("returns {} when the file has no tiers key", () => {
    expect(loadBeholdConfig(make(JSON.stringify({})))).toEqual({});
  });

  it("returns {} for unparseable JSON — never throws", () => {
    expect(loadBeholdConfig(make("{ not valid json"))).toEqual({});
  });

  it("returns {} when envVar is missing or not a string", () => {
    expect(loadBeholdConfig(make(JSON.stringify({ tiers: { values: ["light"] } })))).toEqual({});
    expect(loadBeholdConfig(make(JSON.stringify({ tiers: { envVar: 7, values: ["light"] } })))).toEqual({});
  });

  it("returns {} when values is missing, empty, or not an array", () => {
    expect(loadBeholdConfig(make(JSON.stringify({ tiers: { envVar: "LOOM_TIER" } })))).toEqual({});
    expect(loadBeholdConfig(make(JSON.stringify({ tiers: { envVar: "LOOM_TIER", values: [] } })))).toEqual({});
    expect(loadBeholdConfig(make(JSON.stringify({ tiers: { envVar: "LOOM_TIER", values: "light" } })))).toEqual({});
  });

  it("drops non-string entries from values, keeping the rest", () => {
    const dir = make(JSON.stringify({ tiers: { envVar: "LOOM_TIER", values: ["light", 7, "production"] } }));
    expect(loadBeholdConfig(dir)).toEqual({ tiers: { envVar: "LOOM_TIER", values: ["light", "production"] } });
  });

  it("reads estate members (#236) alongside tiers, and keeps only string entries", () => {
    expect(loadBeholdConfig(make(JSON.stringify({ members: ["a", 7, "b"] })))).toEqual({ members: ["a", "b"] });
    expect(loadBeholdConfig(make(JSON.stringify({ members: [] })))).toEqual({});
  });
});

/** #236: the shape the doctor's first line and the CLI's startup warning both
 * read. Sync, so these build their own fixture dirs. */
describe("detectProjectShape", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const make = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "behold-shape-"));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  };

  it("is a project when a chant config is present, whatever else the directory holds", () => {
    const dir = make({ "chant.config.ts": "export default {};", "package.json": JSON.stringify({ workspaces: ["a"] }) });
    expect(detectProjectShape(dir)).toEqual({ kind: "project", configFile: join(dir, "chant.config.ts") });
  });

  it("reads the other config filenames chant accepts", () => {
    expect(detectProjectShape(make({ "chant.config.mjs": "export default {};" })).kind).toBe("project");
  });

  it("is an estate when .behold.json names member projects", () => {
    const dir = make({
      ".behold.json": JSON.stringify({ members: ["a", "b"] }),
      "a/chant.config.ts": "export default {};",
      "b/chant.config.ts": "export default {};",
    });
    expect(detectProjectShape(dir)).toEqual({ kind: "estate", members: ["a", "b"], membersFrom: "behold-config" });
  });

  it("falls back to npm workspaces, keeping only the members that are chant projects", () => {
    const dir = make({
      "package.json": JSON.stringify({ workspaces: ["cp", "tooling"] }),
      "cp/chant.config.ts": "export default {};",
      "tooling/package.json": "{}",
    });
    expect(detectProjectShape(dir)).toEqual({ kind: "estate", members: ["cp"], membersFrom: "workspaces" });
  });

  it("is none for a directory that is neither — #193's dead end", () => {
    expect(detectProjectShape(make({ "notes.txt": "" }))).toEqual({ kind: "none" });
    // A workspaces root whose members are not chant projects is not an estate.
    expect(detectProjectShape(make({ "package.json": JSON.stringify({ workspaces: ["x"] }), "x/package.json": "{}" }))).toEqual({
      kind: "none",
    });
  });
});


// #165: the executor contract — designate the WORKFLOW, fail closed on anything else.
describe("readExecutor", () => {
  it("keeps a well-formed designation per env", () => {
    expect(readExecutor({ executor: { prod: { forge: "github", workflow: "deploy-prod.yml" } } })).toEqual({
      prod: { forge: "github", workflow: "deploy-prod.yml" },
    });
  });

  it("keeps a malformed designation as invalid, with the reason — never drops it (a dropped entry would fall Deploy back to the laptop)", () => {
    const out = readExecutor({ executor: { prod: { forge: "gitub", workflow: "deploy.yml" }, staging: "github", dev: { forge: "github", workflow: "../x.yml" } } })!;
    expect(out.prod).toEqual({ invalid: expect.stringMatching(/executor\.prod\.forge must be one of github, gitlab, forgejo/) });
    expect(out.staging).toEqual({ invalid: expect.stringMatching(/executor\.staging must be \{forge, workflow\}/) });
    expect(out.dev).toEqual({ invalid: expect.stringMatching(/executor\.dev\.workflow must name a file/) });
  });

  it("recognises gitlab and forgejo as forges (behold has no trigger for them, but the env is still designated away from the laptop)", () => {
    expect(readExecutor({ executor: { prod: { forge: "gitlab", workflow: "deploy.yml" } } })).toEqual({ prod: { forge: "gitlab", workflow: "deploy.yml" } });
  });

  it("is undefined for no block, or a block that isn't an object", () => {
    expect(readExecutor({})).toBeUndefined();
    expect(readExecutor({ executor: "github" })).toBeUndefined();
    expect(readExecutor({ executor: [] })).toBeUndefined();
    expect(readExecutor(undefined)).toBeUndefined();
  });

  it("rides on loadBeholdConfig beside tiers and members", () => {
    const d = tmpBeholdConfig(JSON.stringify({ executor: { prod: { forge: "github", workflow: "deploy-prod.yml" } } }));
    expect(loadBeholdConfig(d)).toEqual({ executor: { prod: { forge: "github", workflow: "deploy-prod.yml" } } });
    rmSync(d, { recursive: true, force: true });
  });
});


describe("executorDesignation — per member, not per primary (#165)", () => {
  it("answers from the directory asked, and caches per directory", () => {
    const member = tmpBeholdConfig(JSON.stringify({ executor: { prod: { forge: "github", workflow: "deploy-prod.yml" } } }));
    const primary = tmpBeholdConfig(JSON.stringify({}));
    resetExecutorCache();
    expect(executorDesignation(member, "prod")).toEqual({ forge: "github", workflow: "deploy-prod.yml" });
    expect(executorDesignation(member, "staging")).toBeUndefined();
    expect(executorDesignation(primary, "prod")).toBeUndefined();
    expect(executorDesignation(member, undefined)).toBeUndefined();
    // Cached: rewriting the file does not change the answer until reset.
    writeFileSync(join(member, ".behold.json"), JSON.stringify({}));
    expect(executorDesignation(member, "prod")).toBeDefined();
    resetExecutorCache(member);
    expect(executorDesignation(member, "prod")).toBeUndefined();
    rmSync(member, { recursive: true, force: true });
    rmSync(primary, { recursive: true, force: true });
  });
});
