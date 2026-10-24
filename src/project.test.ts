import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { detectProject, detectProjectShape, hasRetiredTiers, loadBeholdConfig, readTierParam } from "./project.ts";
import { servesAsEstate } from "./member-kind.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function tmpProject(config: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-project-"));
  if (config !== null) writeFileSync(join(dir, "chant.config.ts"), config);
  return dir;
}

/** A tmp project root with (or without) a `.behold.json` (tmpProject, above,
 * writes `chant.config.ts`). `raw`, when given, is written as-is, so a test can
 * also cover malformed JSON, not just the happy path. */
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

  // #470: the tier axis is a build-time parameter with a string enum.
  it("reads the tier axis from a buildParams entry with a string enum", async () => {
    const dir = make(
      `export default { lexicons: ["aws"], buildParams: { env: { type: "string", default: "dev" }, tier: { type: "string", enum: ["light", "production", "production-ha"], default: "light", env: "LOOM_TIER" } } };`,
    );
    expect((await detectProject(dir)).tiers).toEqual({ param: "tier", values: ["light", "production", "production-ha"], env: "LOOM_TIER" });
  });

  it("reads a tier axis from buildParams alone, with nothing else declared", async () => {
    const dir = make(`export default { buildParams: { size: { enum: ["small", "big"] } } };`);
    expect(await detectProject(dir)).toEqual({ environments: [], lexicons: [], tiers: { param: "size", values: ["small", "big"] } });
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

// #470: what is left of `.behold.json` is `members` and `executor`; `tiers`,
// `approver` and `behaviour` are read elsewhere now.
describe("loadBeholdConfig", () => {
  let dirs: string[] = [];
  beforeAll(() => (dirs = []));
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const make = (raw: string | null) => {
    const d = tmpBeholdConfig(raw);
    dirs.push(d);
    return d;
  };

  it("no longer reads tiers or behaviour (#470)", () => {
    const dir = make(JSON.stringify({ tiers: { envVar: "LOOM_TIER", values: ["light", "production"] }, behaviour: { traffic: "100 rps" } }));
    expect(loadBeholdConfig(dir)).toEqual({});
    expect(hasRetiredTiers(dir)).toBe(true);
    expect(hasRetiredTiers(make(JSON.stringify({ members: ["a"] })))).toBe(false);
    expect(hasRetiredTiers(make(null))).toBe(false);
  });

  it("returns {} when the file is absent, empty or unparseable — never throws", () => {
    expect(loadBeholdConfig(make(null))).toEqual({});
    expect(loadBeholdConfig(make(JSON.stringify({})))).toEqual({});
    expect(loadBeholdConfig(make("{ not valid json"))).toEqual({});
  });

  it("reads estate members (#236), and keeps only member-shaped entries", () => {
    expect(loadBeholdConfig(make(JSON.stringify({ members: ["a", 7, "b"] })))).toEqual({
      members: [
        { dir: "a", kind: "chant" },
        { dir: "b", kind: "chant" },
      ],
    });
    expect(loadBeholdConfig(make(JSON.stringify({ members: [] })))).toEqual({});
  });

  // #368: the object form, beside the string form.
  it("a bare string and {dir} and {dir, kind: chant} are one declaration", () => {
    const one = loadBeholdConfig(make(JSON.stringify({ members: ["a", { dir: "b" }, { dir: "c", kind: "chant" }] })));
    expect(one).toEqual({
      members: [
        { dir: "a", kind: "chant" },
        { dir: "b", kind: "chant" },
        { dir: "c", kind: "chant" },
      ],
    });
  });

  it("keeps a member whose kind it cannot read, with the reason — never silently as chant", () => {
    const cfg = loadBeholdConfig(make(JSON.stringify({ members: [{ dir: "x", kind: "pulumi" }, { dir: "y", kind: "choudoufu" }, { kind: "chant" }, { dir: "" }] })));
    expect(cfg.members).toHaveLength(2); // an entry with no dir is not a declaration
    expect(cfg.members![0]).toEqual({ dir: "x", invalid: expect.stringContaining('unknown member kind "pulumi"') });
    expect(cfg.members![0]).toEqual({ dir: "x", invalid: expect.stringContaining("kinds are: chant, choudoufu") });
    // #369: choudoufu is a registered kind, so its declaration is kept as one.
    expect(cfg.members![1]).toEqual({ dir: "y", kind: "choudoufu" });
  });
});

/** #236: the shape the doctor's first line and the CLI's startup warning both
 * read. Sync, so these build their own fixture dirs. */
describe("readTierParam (#470)", () => {
  it("prefers the entry named tier, else the first with a string enum", () => {
    expect(readTierParam({ size: { type: "string", enum: ["s", "l"] }, tier: { type: "string", enum: ["a", "b"] } })).toEqual({ param: "tier", values: ["a", "b"] });
    expect(readTierParam({ region: { type: "string" }, size: { type: "string", enum: ["s", "l"] } })).toEqual({ param: "size", values: ["s", "l"] });
    // A `tier` that does not qualify falls through to the next that does.
    expect(readTierParam({ tier: { type: "string" }, size: { enum: ["s"] } })).toEqual({ param: "size", values: ["s"] });
  });

  it("keeps only string enum members and a string env mapping", () => {
    expect(readTierParam({ tier: { enum: ["a", 7, "b"], env: 3 } })).toEqual({ param: "tier", values: ["a", "b"] });
    expect(readTierParam({ tier: { enum: ["a"], env: "T" } })).toEqual({ param: "tier", values: ["a"], env: "T" });
  });

  it("is undefined for no qualifying entry", () => {
    for (const bad of [undefined, null, [], "tier", {}, { tier: { type: "number", enum: [1, 2] } }, { tier: { enum: [] } }, { tier: { enum: "a" } }, { tier: null }]) {
      expect(readTierParam(bad)).toBeUndefined();
    }
  });
});

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

  it("is a project with a chant.config.json, as with a chant.config.ts (behold#697)", async () => {
    const dir = make({ "chant.config.json": JSON.stringify({ lexicons: ["aws"], environments: ["prod"], sourceDir: "infra" }) });
    expect(detectProjectShape(dir)).toEqual({ kind: "project", configFile: join(dir, "chant.config.json") });
    expect(await detectProject(dir)).toEqual({ environments: ["prod"], lexicons: ["aws"], sourceDir: "infra" });
    // The .ts wins when both are there, as in chant.
    const both = make({ "chant.config.ts": "export default {};", "chant.config.json": "{}" });
    expect(detectProjectShape(both).configFile).toBe(join(both, "chant.config.ts"));
  });

  it("is an estate when .behold.json names member projects", () => {
    const dir = make({
      ".behold.json": JSON.stringify({ members: ["a", "b"] }),
      "a/chant.config.ts": "export default {};",
      "b/chant.config.ts": "export default {};",
    });
    expect(detectProjectShape(dir)).toEqual({
      kind: "estate",
      members: [
        { dir: "a", kind: "chant" },
        { dir: "b", kind: "chant" },
      ],
      membersFrom: "behold-config",
    });
  });

  it("falls back to npm workspaces, keeping only the members some kind claims", () => {
    const dir = make({
      "package.json": JSON.stringify({ workspaces: ["cp", "tooling"] }),
      "cp/chant.config.ts": "export default {};",
      "tooling/package.json": "{}",
    });
    // A workspace no kind claims was never a declaration: skipped, not reported.
    expect(detectProjectShape(dir)).toEqual({ kind: "estate", members: [{ dir: "cp", kind: "chant" }], membersFrom: "workspaces" });
  });

  // #368: a declaration is a claim behold checks, and a failed claim is
  // reported rather than dropped — the silent drop is what a choudoufu
  // member used to disappear into.
  it("reports a declared member that fails its kind's probe, and one whose kind it does not know", () => {
    const dir = make({
      ".behold.json": JSON.stringify({ members: ["a", { dir: "b", kind: "chant" }, { dir: "c", kind: "pulumi" }] }),
      "a/chant.config.ts": "export default {};",
      "b/README.md": "not a chant project",
    });
    expect(detectProjectShape(dir)).toEqual({
      kind: "estate",
      members: [{ dir: "a", kind: "chant" }],
      membersFrom: "behold-config",
      invalidMembers: [
        { dir: "b", invalid: "declared as chant, but b has no a chant.config.* file" },
        { dir: "c", invalid: expect.stringContaining('unknown member kind "pulumi"') },
      ],
    });
  });

  // #369: the choudoufu kind's probe is a `live { … }` block in a root *.tf,
  // or (#387) the `estate.chdf.hcl` sidecar.
  it("keeps a declared choudoufu member whose root *.tf carries a live block, and reports one whose does not", () => {
    const dir = make({
      ".behold.json": JSON.stringify({ members: ["app", { dir: "net", kind: "choudoufu" }, { dir: "plain", kind: "choudoufu" }] }),
      "app/chant.config.ts": "export default {};",
      "net/main.tf": 'terraform {\n  live {\n    estate = "net"\n  }\n}\n',
      "plain/main.tf": 'resource "aws_vpc" "x" {}\n',
    });
    expect(detectProjectShape(dir)).toEqual({
      kind: "estate",
      members: [
        { dir: "app", kind: "chant" },
        { dir: "net", kind: "choudoufu" },
      ],
      membersFrom: "behold-config",
      invalidMembers: [{ dir: "plain", invalid: "declared as choudoufu, but plain has no an `estate.chdf.hcl` sidecar or a `live { estate = … }` block in a root *.tf file" }],
    });
    // Workspaces: a choudoufu directory is claimed by its kind too; a chant
    // project is chant whatever else it holds.
    const ws = make({
      "package.json": JSON.stringify({ workspaces: ["both", "net"] }),
      "both/chant.config.ts": "export default {};",
      "both/main.tf": "live {\n}\n",
      "net/main.tf": "live {\n}\n",
    });
    expect(detectProjectShape(ws).members).toEqual([
      { dir: "both", kind: "chant" },
      { dir: "net", kind: "choudoufu" },
    ]);
  });

  // #387: the sidecar is what `tools/estate-gen` writes, so a cohort has no
  // `live` block anywhere and used to fail its own declared kind's probe.
  it("keeps a declared choudoufu member declared by the estate.chdf.hcl sidecar", () => {
    const dir = make({
      ".behold.json": JSON.stringify({ members: [{ dir: "s3", kind: "choudoufu" }, { dir: "net", kind: "choudoufu" }] }),
      "s3/estate.chdf.hcl": 'estate = "s3-cohort"\n\nrecord_store "local" {\n  path = ".tofu-records"\n}\n',
      "s3/s3.tf": 'resource "aws_s3_bucket" "one" {\n  bucket = "one"\n}\n',
      "net/main.tf": 'terraform {\n  live {\n    estate = "net"\n  }\n}\n',
    });
    expect(detectProjectShape(dir).members).toEqual([
      { dir: "s3", kind: "choudoufu" },
      { dir: "net", kind: "choudoufu" },
    ]);
  });

  // #387: a rendered cohort is a bare directory nobody wrote a member list
  // for, and `behold serve <it>` has taken one since #369 — so the shape says
  // "a member" rather than the dead end doctor used to print.
  it("reads a directory that is itself a member of a non-chant kind as an estate of one", () => {
    const dir = make({
      "estate.chdf.hcl": 'estate = "s3-cohort"\n',
      "s3.tf": 'resource "aws_s3_bucket" "one" {\n  bucket = "one"\n}\n',
    });
    expect(detectProjectShape(dir)).toEqual({ kind: "estate", members: [{ dir: ".", kind: "choudoufu" }], membersFrom: "itself" });
    // A chant project is still a project, not an estate of itself.
    expect(detectProjectShape(make({ "chant.config.ts": "export default {};" })).kind).toBe("project");
    // And a directory no kind claims is still the dead end.
    expect(detectProjectShape(make({ "README.md": "" })).kind).toBe("none");
  });

  it("is none, with the reasons, when every declared member is invalid", () => {
    const dir = make({ ".behold.json": JSON.stringify({ members: [{ dir: "b", kind: "chant" }] }), "b/README.md": "" });
    expect(detectProjectShape(dir)).toEqual({
      kind: "none",
      invalidMembers: [{ dir: "b", invalid: expect.stringContaining("declared as chant") }],
    });
  });

  // #384: the lane #378 exists for — "every estate this exists to draw is a
  // directory of `.tf` files and nothing else". Nothing declares it a member;
  // its own shape does.
  it("is an estate of one when the directory itself is a member of a kind that is not chant", () => {
    const tf = make({
      "envs/prod/versions.tf": "terraform {\n  required_providers {\n    aws = {}\n  }\n}\n",
      "envs/prod/main.tf": 'resource "aws_s3_bucket" "b" {}\n',
      "modules/persona/versions.tf": "terraform {\n  required_providers {\n    aws = {}\n  }\n}\n",
      "modules/persona/main.tf": 'resource "aws_iam_role" "this" {}\n',
    });
    expect(detectProjectShape(tf)).toEqual({ kind: "estate", members: [{ dir: ".", kind: "terraform" }], membersFrom: "itself" });

    // A chant project that happens to hold Terraform is still a chant project,
    // and a choudoufu estate is still choudoufu — the table's order decides.
    const chant = make({ "chant.config.ts": "export default {};", "main.tf": 'terraform {}\nresource "aws_vpc" "x" {}\n' });
    expect(detectProjectShape(chant).kind).toBe("project");
    const tofu = make({ "main.tf": 'terraform {\n  live {\n    estate = "net"\n  }\n}\n', "vpc.tf": 'resource "aws_vpc" "x" {}\n' });
    expect(detectProjectShape(tofu).members).toEqual([{ dir: ".", kind: "choudoufu" }]);
  });

  it("is none for a directory that is neither — #193's dead end", () => {
    expect(detectProjectShape(make({ "notes.txt": "" }))).toEqual({ kind: "none" });
    // A workspaces root whose members are not chant projects is not an estate.
    expect(detectProjectShape(make({ "package.json": JSON.stringify({ workspaces: ["x"] }), "x/package.json": "{}" }))).toEqual({
      kind: "none",
    });
  });
});


// #470: `executor` is not read from `.behold.json` any more (src/executor.ts reads it from chant).
describe("loadBeholdConfig ignores a retired executor block (#470)", () => {
  it("keeps only members", () => {
    const d = tmpBeholdConfig(JSON.stringify({ executor: { prod: { forge: "github", workflow: "deploy-prod.yml" } }, members: ["a"] }));
    expect(loadBeholdConfig(d)).toEqual({ members: [{ dir: "a", kind: "chant" }] });
    rmSync(d, { recursive: true, force: true });
  });
});

// #389: the workbench's generated entries (an estate-gen cohort, a terralith)
// are ONE choudoufu estate each, and `behold serve <that dir>` used to answer
// the no-project card over them — the single-project read is `chant graph`, and
// a directory with no chant.config.ts and no lexicon has nothing for it to
// read. `servesAsEstate` is the predicate that routes such a directory through
// the estate compose path instead, where the member's own kind reads it.
describe("servesAsEstate", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const make = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "behold-serves-"));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  };

  it("composes one directory that is a non-chant member — the sidecar form and the live-block form", () => {
    expect(servesAsEstate([make({ "estate.chdf.hcl": 'estate = "s3-cohort"\n' })])).toBe(true);
    expect(servesAsEstate([make({ "main.tf": 'terraform {\n  live {\n    estate = "tl"\n  }\n}\n' })])).toBe(true);
  });

  it("leaves one chant project on the single-project path, as it always was", () => {
    expect(servesAsEstate([make({ "chant.config.ts": "export default {};" })])).toBe(false);
  });

  it("leaves a directory no kind claims on the single-project path, so #193's no-project card still explains it", () => {
    expect(servesAsEstate([make({ "README.md": "" })])).toBe(false);
  });

  it("composes more than one directory whatever the kinds, and composes nothing for no directory", () => {
    const a = make({ "chant.config.ts": "export default {};" });
    const b = make({ "chant.config.ts": "export default {};" });
    expect(servesAsEstate([a, b])).toBe(true);
    expect(servesAsEstate([])).toBe(false);
  });
});
