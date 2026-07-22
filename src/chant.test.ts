import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn as spawnMock } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  graphFlags,
  graphArgs,
  graphPath,
  componentStatusArgs,
  ciPipelineArgs,
  parseCiPipeline,
  envOverridesFor,
  lifecyclePlanArgs,
  applyArgs,
  runChantRaw,
  stripAnsi,
  classifyChantFailure,
  ChantCliError,
  graphIr,
} from "./chant.ts";
import { overlayStatus } from "./overlay.ts";

// Mocked so `runChantRaw`'s env-override plumbing (M2, #54) can be verified
// against the actual spawn call, without shelling a real chant binary.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

/** A minimal fake ChildProcess: emits `data` on stdout/stderr, then `close`,
 * on the next microtask — enough for `runChantRaw`'s listeners. */
function fakeProc(code: number, stdout = "", stderr = ""): ReturnType<typeof spawnMock> {
  const proc = new EventEmitter() as unknown as ReturnType<typeof spawnMock>;
  const out = new EventEmitter();
  const err = new EventEmitter();
  Object.assign(proc, { stdout: out, stderr: err });
  // Emit once the consumer attaches its `close` listener — not on a
  // construction-time microtask — so the fake is robust to any async work the
  // caller does before spawning (e.g. graphPath → detectProject, #71).
  let fired = false;
  proc.on("newListener", (event) => {
    if (event !== "close" || fired) return;
    fired = true;
    queueMicrotask(() => {
      if (stdout) out.emit("data", Buffer.from(stdout));
      if (stderr) err.emit("data", Buffer.from(stderr));
      proc.emit("close", code);
    });
  });
  return proc;
}

describe("graphFlags", () => {
  it("is empty for no options", () => {
    expect(graphFlags({})).toEqual([]);
  });

  it("maps detail, lens, direction, env", () => {
    expect(graphFlags({ detail: 1, lens: "blast:vpc", down: true, env: "prod" })).toEqual([
      "--detail",
      "1",
      "--lens",
      "blast:vpc",
      "--down",
      "--env",
      "prod",
    ]);
  });

  it("adds live/overlay when set", () => {
    expect(graphFlags({ live: true, overlay: true, env: "prod" })).toEqual([
      "--env",
      "prod",
      "--live",
      "--overlay",
    ]);
  });

  it("never emits --tier/--target — the M2 lenses are env overrides, not chant CLI flags (#54)", () => {
    expect(graphFlags({ tier: "full", target: "http://localhost:4566" })).toEqual([]);
  });
});

// M2 (#54): the tier/target lenses. Not chant CLI flags — env overrides for
// the shell-out (see envOverridesFor + runChantRaw's envOverride param).
// #70: the tier's env var name is no longer hardcoded to LOOM_TIER — it comes
// from `opts.tierEnvVar` (sourced from the served project's `.behold.json`,
// src/project.ts `loadBeholdConfig`), so these tests thread it explicitly,
// standing in for whatever a project's own `.behold.json` declares.
describe("envOverridesFor", () => {
  it("is undefined for no tier/target — no spawn env override needed", () => {
    expect(envOverridesFor({})).toBeUndefined();
    expect(envOverridesFor({ env: "prod", live: true })).toBeUndefined();
  });

  it("maps tier -> the configured tierEnvVar (loomster convention: LOOM_TIER)", () => {
    expect(envOverridesFor({ tier: "full", tierEnvVar: "LOOM_TIER" })).toEqual({ LOOM_TIER: "full" });
  });

  it("maps tier -> whatever env var name a project's .behold.json declares — not hardcoded", () => {
    expect(envOverridesFor({ tier: "full", tierEnvVar: "DEPLOY_TIER" })).toEqual({ DEPLOY_TIER: "full" });
  });

  it("drops tier with no tierEnvVar — no var name to set it under (a project declaring no tiers)", () => {
    expect(envOverridesFor({ tier: "full" })).toBeUndefined();
  });

  it("maps target -> AWS_ENDPOINT_URL", () => {
    expect(envOverridesFor({ target: "http://localhost:4566" })).toEqual({
      AWS_ENDPOINT_URL: "http://localhost:4566",
    });
  });

  it("maps both together", () => {
    expect(envOverridesFor({ tier: "light", tierEnvVar: "LOOM_TIER", target: "http://localhost:4566" })).toEqual({
      LOOM_TIER: "light",
      AWS_ENDPOINT_URL: "http://localhost:4566",
    });
  });
});

describe("graphArgs", () => {
  it("builds the base view-format command for the entity graph", () => {
    expect(graphArgs("proj/src", "ir", {}, false)).toEqual(["graph", "proj/src", "--format", "ir"]);
  });

  it("inserts --components ahead of --format for the component-DAG projection (M1.0)", () => {
    expect(graphArgs("proj/src", "ir", {}, true)).toEqual(["graph", "proj/src", "--components", "--format", "ir"]);
  });

  it("still appends graphFlags after --format for either projection", () => {
    expect(graphArgs("proj/src", "layout", { env: "local" }, true)).toEqual([
      "graph",
      "proj/src",
      "--components",
      "--format",
      "layout",
      "--env",
      "local",
    ]);
    expect(graphArgs("proj/src", "layout", { env: "local" }, false)).toEqual([
      "graph",
      "proj/src",
      "--format",
      "layout",
      "--env",
      "local",
    ]);
  });
});

// #71: graphPath() honors chant.config.ts's sourceDir/stacks instead of the
// hardcoded literal `src/` check. Real temp-dir fixtures (not mocks) — same
// style as project.test.ts's detectProject tests — since graphPath's whole
// job is reading the filesystem + delegating to detectProject.
describe("graphPath", () => {
  let dirs: string[] = [];
  const make = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "behold-graphpath-"));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const p = join(dir, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
    }
    return dir;
  };
  afterEach(() => {
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    dirs = [];
  });

  it("resolves a configured non-src sourceDir (the positive case, #71)", async () => {
    const dir = make({ "chant.config.ts": `export default { lexicons: ["aws"], sourceDir: "infra" };` });
    expect(await graphPath(dir)).toBe(join(dir, "infra"));
  });

  it("resolves sourceDir even when that dir doesn't exist yet — config is authoritative, not an existsSync guess", async () => {
    const dir = make({ "chant.config.ts": `export default { lexicons: ["aws"], sourceDir: "not-yet-created" };` });
    expect(await graphPath(dir)).toBe(join(dir, "not-yet-created"));
  });

  it("no-regression: a project with sourceDir: \"src\" (loomster's shape) resolves identically to before (src/)", async () => {
    const dir = make({
      "chant.config.ts": `export default { lexicons: ["aws"], sourceDir: "src" };`,
      "src/network.ts": "export {};",
    });
    expect(await graphPath(dir)).toBe(join(dir, "src"));
  });

  it("no-regression: no sourceDir declared, src/ present — falls back to the legacy src/-then-root heuristic", async () => {
    const dir = make({
      "chant.config.ts": `export default { lexicons: ["aws"] };`,
      "src/network.ts": "export {};",
    });
    expect(await graphPath(dir)).toBe(join(dir, "src"));
  });

  it("no-regression: no config at all, src/ present — legacy heuristic unaffected", async () => {
    const dir = make({ "src/network.ts": "export {};" });
    expect(await graphPath(dir)).toBe(join(dir, "src"));
  });

  it("no-regression: no config, no src/ — falls back to the project root", async () => {
    const dir = make({});
    expect(await graphPath(dir)).toBe(dir);
  });

  // #76 (follow-up to #71): real per-stack rendering — the warn-only path
  // above is retired. A multi-stack project's `stacks[]` is resolved via a
  // 2nd `opts` arg (`opts.stack`), NOT `sourceDir` — a declared `stacks[]`
  // always wins over `sourceDir` when both are set (the design: a multi-stack
  // project's whole point is its independently-deployed stacks).
  describe("stacks[] (#76): the stack picker's resolution", () => {
    it("defaults to the FIRST declared stack when no stack is selected (opts omitted entirely — the one-arg call #71's tests rely on keeps working)", async () => {
      const dir = make({
        "chant.config.ts":
          `export default { lexicons: ["aws"], ` +
          `stacks: [{ name: "api", src: "stacks/api" }, { name: "web", src: "stacks/web" }] };`,
      });
      expect(await graphPath(dir)).toBe(join(dir, "stacks/api"));
    });

    it("defaults to the FIRST declared stack when opts is given but opts.stack is unset", async () => {
      const dir = make({
        "chant.config.ts":
          `export default { lexicons: ["aws"], ` +
          `stacks: [{ name: "api", src: "stacks/api" }, { name: "web", src: "stacks/web" }] };`,
      });
      expect(await graphPath(dir, {})).toBe(join(dir, "stacks/api"));
    });

    it("resolves a selected stack's src when opts.stack names a declared stack", async () => {
      const dir = make({
        "chant.config.ts":
          `export default { lexicons: ["aws"], ` +
          `stacks: [{ name: "api", src: "stacks/api" }, { name: "web", src: "stacks/web" }] };`,
      });
      expect(await graphPath(dir, { stack: "web" })).toBe(join(dir, "stacks/web"));
      expect(await graphPath(dir, { stack: "api" })).toBe(join(dir, "stacks/api"));
    });

    it("falls back to the first stack when opts.stack names no declared stack — never throws, never picks nothing", async () => {
      const dir = make({
        "chant.config.ts":
          `export default { lexicons: ["aws"], ` +
          `stacks: [{ name: "api", src: "stacks/api" }, { name: "web", src: "stacks/web" }] };`,
      });
      expect(await graphPath(dir, { stack: "nonexistent" })).toBe(join(dir, "stacks/api"));
    });

    it("a declared stacks[] wins over sourceDir even when both are set — sourceDir is not consulted", async () => {
      const dir = make({
        "chant.config.ts":
          `export default { lexicons: ["aws"], sourceDir: "infra", ` +
          `stacks: [{ name: "api", src: "stacks/api" }, { name: "web", src: "stacks/web" }] };`,
      });
      expect(await graphPath(dir)).toBe(join(dir, "stacks/api"));
      expect(await graphPath(dir, { stack: "web" })).toBe(join(dir, "stacks/web"));
    });

    it("no stderr warning is emitted anymore — the #71 warn-only path is retired, not just silenced", async () => {
      const dir = make({
        "chant.config.ts": `export default { lexicons: ["aws"], stacks: [{ name: "api", src: "stacks/api" }] };`,
      });
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await graphPath(dir);
        await graphPath(dir, { stack: "api" });
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("no-regression: a single-stack/sourceDir project ignores opts.stack entirely — completely unaffected", async () => {
      const dir = make({ "chant.config.ts": `export default { lexicons: ["aws"], sourceDir: "infra" };` });
      expect(await graphPath(dir, { stack: "anything" })).toBe(join(dir, "infra"));
    });

    it("no-regression: a legacy project (no config) ignores opts.stack entirely", async () => {
      const dir = make({ "src/network.ts": "export {};" });
      expect(await graphPath(dir, { stack: "anything" })).toBe(join(dir, "src"));
    });

    // The committed fixture (e2e/fixtures/multi-stack, #76) — a real on-disk
    // two-stack project, so this feature has one durable, reviewable example
    // outside the temp-dir unit tests above (which cover every resolution
    // branch in isolation).
    it("resolves both of the committed e2e/fixtures/multi-stack fixture's stacks", async () => {
      const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "e2e", "fixtures", "multi-stack");
      expect(await graphPath(fixture)).toBe(join(fixture, "stacks/api"));
      expect(await graphPath(fixture, { stack: "api" })).toBe(join(fixture, "stacks/api"));
      expect(await graphPath(fixture, { stack: "web" })).toBe(join(fixture, "stacks/web"));
    });
  });
});

describe("componentStatusArgs", () => {
  it("builds `components status <env> --live --json` (M1.1 spike Q2)", () => {
    expect(componentStatusArgs("local")).toEqual(["components", "status", "local", "--live", "--json"]);
  });

  it("threads the env through verbatim", () => {
    expect(componentStatusArgs("prod")).toEqual(["components", "status", "prod", "--live", "--json"]);
  });
});

describe("overlayStatus", () => {
  it("maps chant _status tags to drift semantics", () => {
    expect(overlayStatus({ attrs: { _status: "good" } })).toBe("managed");
    expect(overlayStatus({ attrs: { _status: "warn" } })).toBe("foreign");
    expect(overlayStatus({ attrs: { _status: "accent" } })).toBe("pending");
    expect(overlayStatus({ attrs: {} })).toBeUndefined();
  });

  it("M4: the retired sourceAnchoredOverlay placeholder is gone — nothing in the live path can throw", async () => {
    // chant #821 shipped (chant 0.18.31): behold's `/api/overlay` just passes
    // `--live --overlay` through to chant (see chant.ts's graphIr/graphFlags)
    // and reads chant's own `_status` tag (overlayStatus, above). The old
    // placeholder that threw "not implemented — tracked as chant #821" is
    // retired, not just unused — assert it's not even exported anymore, so a
    // stray import of it can't reintroduce a throw into a live route.
    const mod = await import("./overlay.ts");
    expect((mod as Record<string, unknown>).sourceAnchoredOverlay).toBeUndefined();
  });
});

describe("ciPipelineArgs", () => {
  it("is the generate-mode build command with the structured JSON format", () => {
    expect(ciPipelineArgs()).toEqual(["build", "--components", "--generate", "gitlab", "--format", "json"]);
  });

  it("appends --env when set", () => {
    expect(ciPipelineArgs({ env: "local" })).toEqual([
      "build",
      "--components",
      "--generate",
      "gitlab",
      "--format",
      "json",
      "--env",
      "local",
    ]);
  });
});

// Fixture: the real `chant build --components --generate gitlab --format json`
// output for loomster's 7-component set (M1.2 spike, #58), captured against
// `~/checkouts/intentius/loomster`. `jobs` carries stage/needs directly;
// `yaml` is the generated `.gitlab-ci.yml` text — matches the committed
// `.gitlab/components.yml` — that parseCiPipeline reads each job's `script`
// out of (chant's own YAML parser, not a regex scrape).
const LOOMSTER_CI_JSON = JSON.stringify({
  stages: ["wave-1", "wave-2", "wave-3", "wave-4"],
  jobs: [
    { jobName: "loom-cognito", component: "loom-cognito", stage: "wave-1", needs: [] },
    { jobName: "shared-foundation", component: "shared-foundation", stage: "wave-1", needs: [] },
    { jobName: "downstream-stub", component: "downstream-stub", stage: "wave-2", needs: ["shared-foundation"] },
    { jobName: "loom-db", component: "loom-db", stage: "wave-2", needs: ["shared-foundation"] },
    { jobName: "loom-frontend", component: "loom-frontend", stage: "wave-2", needs: ["shared-foundation"] },
    {
      jobName: "loom-backend",
      component: "loom-backend",
      stage: "wave-3",
      needs: ["loom-cognito", "loom-db", "shared-foundation"],
    },
    {
      jobName: "loom-agents",
      component: "loom-agents",
      stage: "wave-4",
      needs: ["loom-backend", "loom-cognito", "shared-foundation"],
    },
  ],
  yaml:
    "stages:\n  - wave-1\n  - wave-2\n  - wave-3\n  - wave-4\n\n" +
    "loom-cognito:\n  stage: wave-1\n  image: node:22-slim\n  script:\n    - chant run --components loom-cognito --env production --dump-outputs loom-cognito.outputs.json\n  artifacts:\n    paths:\n      - loom-cognito.outputs.json\n\n" +
    "shared-foundation:\n  stage: wave-1\n  image: node:22-slim\n  script:\n    - chant run --components shared-foundation --env production --dump-outputs shared-foundation.outputs.json\n  artifacts:\n    paths:\n      - shared-foundation.outputs.json\n\n" +
    "downstream-stub:\n  stage: wave-2\n  image: node:22-slim\n  script:\n    - chant run --components downstream-stub --env production --seed-outputs shared-foundation.outputs.json\n  needs:\n    - shared-foundation\n\n" +
    "loom-db:\n  stage: wave-2\n  image: node:22-slim\n  script:\n    - chant run --components loom-db --env production --seed-outputs shared-foundation.outputs.json --dump-outputs loom-db.outputs.json\n  needs:\n    - shared-foundation\n  artifacts:\n    paths:\n      - loom-db.outputs.json\n\n" +
    "loom-frontend:\n  stage: wave-2\n  image: node:22-slim\n  script:\n    - chant run --components loom-frontend --env production --seed-outputs shared-foundation.outputs.json\n  needs:\n    - shared-foundation\n\n" +
    "loom-backend:\n  stage: wave-3\n  image: node:22-slim\n  script:\n    - chant run --components loom-backend --env production --seed-outputs shared-foundation.outputs.json --seed-outputs loom-db.outputs.json --seed-outputs loom-cognito.outputs.json --dump-outputs loom-backend.outputs.json\n  needs:\n    - loom-cognito\n    - loom-db\n    - shared-foundation\n  artifacts:\n    paths:\n      - loom-backend.outputs.json\n\n" +
    "loom-agents:\n  stage: wave-4\n  image: node:22-slim\n  script:\n    - chant run --components loom-agents --env production --seed-outputs shared-foundation.outputs.json --seed-outputs loom-cognito.outputs.json --seed-outputs loom-backend.outputs.json\n  needs:\n    - loom-backend\n    - loom-cognito\n    - shared-foundation\n",
});

describe("parseCiPipeline", () => {
  it("carries stages and one job per component straight from the structured JSON", () => {
    const { stages, jobs } = parseCiPipeline(LOOMSTER_CI_JSON);
    expect(stages).toEqual(["wave-1", "wave-2", "wave-3", "wave-4"]);
    expect(jobs.map((j) => j.component).sort()).toEqual(
      [
        "downstream-stub",
        "loom-agents",
        "loom-backend",
        "loom-cognito",
        "loom-db",
        "loom-frontend",
        "shared-foundation",
      ].sort(),
    );
  });

  it("matches the epic's worked example — loom-backend: wave-3, needs [loom-cognito, loom-db, shared-foundation]", () => {
    const { jobs } = parseCiPipeline(LOOMSTER_CI_JSON);
    const backend = jobs.find((j) => j.component === "loom-backend")!;
    expect(backend.stage).toBe("wave-3");
    expect(backend.needs.slice().sort()).toEqual(["loom-cognito", "loom-db", "shared-foundation"]);
    expect(backend.script).toHaveLength(1);
    expect(backend.script[0]).toContain("chant run --components loom-backend");
    expect(backend.script[0]).toContain("--seed-outputs shared-foundation.outputs.json");
    expect(backend.script[0]).toContain("--seed-outputs loom-db.outputs.json");
    expect(backend.script[0]).toContain("--seed-outputs loom-cognito.outputs.json");
  });

  it("matches the issue's acceptance example — loom-db: stage wave-2, needs [shared-foundation], runs chant run --components loom-db", () => {
    const { jobs } = parseCiPipeline(LOOMSTER_CI_JSON);
    const db = jobs.find((j) => j.component === "loom-db")!;
    expect(db.stage).toBe("wave-2");
    expect(db.needs).toEqual(["shared-foundation"]);
    expect(db.script[0]).toContain("chant run --components loom-db");
  });

  it("parses script for a job with no needs and no dependents (loom-frontend has needs but nothing depends on it)", () => {
    const { jobs } = parseCiPipeline(LOOMSTER_CI_JSON);
    const frontend = jobs.find((j) => j.component === "loom-frontend")!;
    expect(frontend.needs).toEqual(["shared-foundation"]);
    // No downstream consumer of loom-frontend's outputs, so no --dump-outputs.
    expect(frontend.script[0]).not.toContain("--dump-outputs");
  });
});

describe("lifecyclePlanArgs", () => {
  it("builds `lifecycle plan <env> --live --json` (M2 reconcile facet, #54)", () => {
    expect(lifecyclePlanArgs("local")).toEqual(["lifecycle", "plan", "local", "--live", "--json"]);
  });

  it("threads the env through verbatim", () => {
    expect(lifecyclePlanArgs("prod")).toEqual(["lifecycle", "plan", "prod", "--live", "--json"]);
  });
});

describe("applyArgs", () => {
  it("builds `run <target> --components --env <env> --progress-json` (M3, #54)", () => {
    expect(applyArgs("all", "local")).toEqual(["run", "all", "--components", "--env", "local", "--progress-json"]);
  });

  it("threads a single component name through as the target, verbatim", () => {
    expect(applyArgs("shared-foundation", "prod")).toEqual([
      "run",
      "shared-foundation",
      "--components",
      "--env",
      "prod",
      "--progress-json",
    ]);
  });
});

// M2 (#54): the tier/target lenses must reach the actual spawned chant
// process — not just build a correct `envOverridesFor()` map (tested above).
// This verifies `runChantRaw` merges that map into the spawn's `env`.
describe("runChantRaw — env override reaches the spawn", () => {
  beforeEach(() => vi.mocked(spawnMock).mockReset());

  it("spawns with no explicit `env` option when no override is given — inherits process.env as before", async () => {
    vi.mocked(spawnMock).mockReturnValue(fakeProc(0, "{}"));
    await runChantRaw(["graph", "src", "--format", "ir"], "/proj");
    const opts = vi.mocked(spawnMock).mock.calls[0]![2] as { env?: unknown } | undefined;
    expect(opts?.env).toBeUndefined();
  });

  it("merges the env override over process.env for exactly this spawn (M2 tier/target lenses)", async () => {
    vi.mocked(spawnMock).mockReturnValue(fakeProc(0, "{}"));
    await runChantRaw(["components", "status", "local", "--live", "--json"], "/proj", { LOOM_TIER: "full" });
    const opts = vi.mocked(spawnMock).mock.calls[0]![2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(opts?.env?.LOOM_TIER).toBe("full");
    // process.env's own vars are still the base — merged over, not replaced.
    expect(opts?.env?.PATH).toBe(process.env.PATH);
  });

  it("merges both tier and target overrides", async () => {
    vi.mocked(spawnMock).mockReturnValue(fakeProc(0, "{}"));
    await runChantRaw(["graph", "src", "--format", "ir"], "/proj", {
      LOOM_TIER: "light",
      AWS_ENDPOINT_URL: "http://localhost:4566",
    });
    const opts = vi.mocked(spawnMock).mock.calls[0]![2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(opts?.env?.LOOM_TIER).toBe("light");
    expect(opts?.env?.AWS_ENDPOINT_URL).toBe("http://localhost:4566");
  });
});

describe("stripAnsi", () => {
  it("removes ANSI colour escapes", () => {
    expect(stripAnsi("\x1b[31merror\x1b[0m: broken")).toBe("error: broken");
  });

  it("is a no-op on plain text", () => {
    expect(stripAnsi("plain text, no escapes")).toBe("plain text, no escapes");
  });
});

// #72: classify chant's own stderr into the precondition failures the "open
// your own project" goal routinely hits — lint gate, not-installed/no-
// typegen, and a generic eval failure (e.g. a tier that needs credentials).
// Fixtures below are chant's ACTUAL stderr, captured by shelling
// `graphIr()`/`chant graph --format ir` (0.18.x) against `example/` — the
// lint-gate and not-installed strings straight off chant's own
// cli/handlers/graph.ts ("Refusing to emit graph…") and Node's module
// resolution ("Cannot find package…"); the generic-failure fixture is chant
// surfacing a thrown Error from evaluated source the same way.
describe("classifyChantFailure", () => {
  it("classifies the lint gate — chant graph.ts's own 'Refusing to emit graph' message", () => {
    const stderr =
      "\x1b[31merror\x1b[0m: Refusing to emit graph: source has lint errors. Run `chant lint` and fix them first.";
    const failure = classifyChantFailure(stderr);
    expect(failure.code).toBe("lint");
    expect(failure.message).toBe("error: Refusing to emit graph: source has lint errors. Run `chant lint` and fix them first.");
    expect(failure.remedy).toMatch(/chant lint/);
  });

  it("classifies a missing package — Node's ESM resolution error on an unresolvable import", () => {
    const stderr =
      "\x1b[31merror\x1b[0m: Cannot find package '@intentius/chant-lexicon-aws' imported from " +
      "/private/tmp/behold-72/node_modules/@intentius/chant/src/cli/plugins.ts";
    const failure = classifyChantFailure(stderr);
    expect(failure.code).toBe("not-installed");
    expect(failure.message).toContain("Cannot find package '@intentius/chant-lexicon-aws'");
    expect(failure.remedy).toMatch(/npm install/);
    expect(failure.remedy).toMatch(/chant typegen/);
  });

  it("classifies a missing module the same way — 'Cannot find module' (CJS-style resolution errors)", () => {
    const failure = classifyChantFailure("error: Cannot find module '@intentius/chant'\nRequire stack:\n- /x.js");
    expect(failure.code).toBe("not-installed");
  });

  it("falls back to a generic eval failure for anything else — e.g. a thrown Error from evaluated source", () => {
    const stderr = "\x1b[31merror\x1b[0m: simulated tier eval failure: missing required parameter";
    const failure = classifyChantFailure(stderr);
    expect(failure.code).toBe("eval");
    expect(failure.message).toBe("error: simulated tier eval failure: missing required parameter");
    expect(failure.remedy).toBeTruthy();
  });

  it("never throws on empty stderr — falls back to a generic message", () => {
    const failure = classifyChantFailure("");
    expect(failure.code).toBe("eval");
    expect(failure.message).toBeTruthy();
  });

  it("is case-insensitive on chant's own wording (defensive — matches today's exact casing too)", () => {
    expect(classifyChantFailure("REFUSING TO EMIT GRAPH: source has lint errors.").code).toBe("lint");
    expect(classifyChantFailure("cannot find package 'x'").code).toBe("not-installed");
  });
});

describe("ChantCliError", () => {
  it("carries the plain 'chant <args> exited <code>: <stderr>' message unchanged, for callers that just stringify it", () => {
    const err = new ChantCliError(["graph", "src", "--format", "ir"], 1, "boom");
    expect(err.message).toBe("chant graph src --format ir exited 1: boom");
    expect(err).toBeInstanceOf(Error);
  });

  it("also carries the classified failure alongside the message", () => {
    const err = new ChantCliError(
      ["graph", "src", "--format", "ir"],
      1,
      "error: Refusing to emit graph: source has lint errors. Run `chant lint` and fix them first.",
    );
    expect(err.failure.code).toBe("lint");
    expect(err.failure.remedy).toMatch(/chant lint/);
  });
});

// End-to-end: runChantJson (private, exercised via graphIr) wraps a non-zero
// exit in a ChantCliError rather than a plain Error — the real signal
// server.ts's errorResponse (#72) reads off a caught graph/facet failure.
describe("runChantJson — wraps a non-zero exit in a classified ChantCliError", () => {
  beforeEach(() => vi.mocked(spawnMock).mockReset());

  it("rejects with a ChantCliError carrying the classified failure", async () => {
    vi.mocked(spawnMock).mockReturnValue(
      fakeProc(1, "", "error: Cannot find package '@intentius/chant-lexicon-aws' imported from x.ts"),
    );
    await expect(graphIr("/proj")).rejects.toMatchObject({
      name: "ChantCliError",
      failure: { code: "not-installed" },
    });
  });

  it("still parses stdout as JSON on a zero exit — the happy path is unaffected", async () => {
    vi.mocked(spawnMock).mockReturnValue(fakeProc(0, JSON.stringify({ nodes: [], edges: [] })));
    await expect(graphIr("/proj")).resolves.toEqual({ nodes: [], edges: [] });
  });
});

// #76: the stack lens must reach the ACTUAL spawned `chant graph <src>` call,
// not just graphPath()'s own return value (tested against real temp
// directories above) — this verifies graphIr end-to-end, the same way
// "runChantRaw — env override reaches the spawn" verifies the tier/target
// lenses reach the spawn's `env`. Real temp-dir project + mocked spawn: the
// project directory must actually exist on disk (with a real chant.config.ts
// declaring stacks[]) for graphPath's detectProject to resolve anything —
// only the chant BINARY itself is faked.
describe("graphIr — the stack lens (#76) reaches the actual chant graph invocation", () => {
  let dirs: string[] = [];
  const make = (config: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "behold-graphir-stack-"));
    dirs.push(dir);
    writeFileSync(join(dir, "chant.config.ts"), config);
    return dir;
  };
  // Reset BEFORE each test too, not just after — a prior describe block's
  // last test can leave calls recorded on the shared module-level mock, which
  // would otherwise make `mock.calls[0]` here read a stale call.
  beforeEach(() => vi.mocked(spawnMock).mockReset());
  afterEach(() => {
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    dirs = [];
  });

  const STACKS_CONFIG =
    `export default { lexicons: ["aws"], ` +
    `stacks: [{ name: "api", src: "stacks/api" }, { name: "web", src: "stacks/web" }] };`;

  it("shells `chant graph <selected stack's src> --format ir` when opts.stack picks a declared stack", async () => {
    const dir = make(STACKS_CONFIG);
    vi.mocked(spawnMock).mockReturnValue(fakeProc(0, JSON.stringify({ nodes: [], edges: [] })));
    await graphIr(dir, { stack: "web" });
    const args = vi.mocked(spawnMock).mock.calls[0]![1] as string[];
    expect(args).toEqual(["graph", join(dir, "stacks/web"), "--format", "ir"]);
  });

  it("shells `chant graph <first stack's src> --format ir` when no stack is selected — the picker's default", async () => {
    const dir = make(STACKS_CONFIG);
    vi.mocked(spawnMock).mockReturnValue(fakeProc(0, JSON.stringify({ nodes: [], edges: [] })));
    await graphIr(dir);
    const args = vi.mocked(spawnMock).mock.calls[0]![1] as string[];
    expect(args).toEqual(["graph", join(dir, "stacks/api"), "--format", "ir"]);
  });
});
