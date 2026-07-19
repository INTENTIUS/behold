import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn as spawnMock } from "node:child_process";
import {
  graphFlags,
  graphArgs,
  componentStatusArgs,
  ciPipelineArgs,
  parseCiPipeline,
  envOverridesFor,
  lifecyclePlanArgs,
  applyArgs,
  runChantRaw,
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
  queueMicrotask(() => {
    if (stdout) out.emit("data", Buffer.from(stdout));
    if (stderr) err.emit("data", Buffer.from(stderr));
    proc.emit("close", code);
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
describe("envOverridesFor", () => {
  it("is undefined for no tier/target — no spawn env override needed", () => {
    expect(envOverridesFor({})).toBeUndefined();
    expect(envOverridesFor({ env: "prod", live: true })).toBeUndefined();
  });

  it("maps tier -> LOOM_TIER", () => {
    expect(envOverridesFor({ tier: "full" })).toEqual({ LOOM_TIER: "full" });
  });

  it("maps target -> AWS_ENDPOINT_URL", () => {
    expect(envOverridesFor({ target: "http://localhost:4566" })).toEqual({
      AWS_ENDPOINT_URL: "http://localhost:4566",
    });
  });

  it("maps both together", () => {
    expect(envOverridesFor({ tier: "light", target: "http://localhost:4566" })).toEqual({
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
