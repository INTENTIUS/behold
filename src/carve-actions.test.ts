// #254: the carve walkthrough's two local actions and the write boundary
// around them.
//
// The successful runs are driven against a FAKE chant installed into a temp
// demo copy — a package.json + a bin script that records its argv and writes
// what real chant writes. That is the point: what is being tested here is
// behold's half of the contract (the argv it builds, the directory it creates
// before chant needs it, what it reads back, what it refuses), not chant's.
// The real chant runs in the walkthrough itself, and `example-carve/README.md`
// records the version those outputs were verified against.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import {
  carveSlug,
  carveWriteBlock,
  insideDemo,
  readArtifacts,
  runCarveBridge,
  runCarveEmit,
  runCarveObserve,
  selectFromReport,
  shortenIn,
  type CarveDemo,
} from "./carve-actions.ts";
import type { CarveReport } from "./carve-lens.ts";

const REPORT: CarveReport = {
  from: "legacy-tf",
  count: 2,
  bands: { "clean leaf": 1, "leave in Terraform": 1 },
  resources: [
    { address: "aws_s3_bucket.assets", score: 88, band: "clean leaf", mapsTo: "AWS::S3::Bucket", breakdown: { inbound: 1, outbound: 0, tier: 1 } },
    { address: "random_pet.suffix", score: 0, band: "leave in Terraform", breakdown: { tier: null } },
  ],
};

/**
 * A demo copy with a fake project-local chant.
 *
 * The bin script appends its argv to `argv.log` and then does what the real
 * command does to the filesystem, so the assertions below can be about paths
 * and flags rather than about mocks.
 */
function fakeDemo(): { demo: CarveDemo; argv: () => string[][]; root: string } {
  const root = mkdtempSync(join(tmpdir(), "behold-carve-demo-"));
  mkdirSync(join(root, "legacy-tf"), { recursive: true });
  writeFileSync(join(root, "legacy-tf", "storage.tf"), 'resource "aws_s3_bucket" "assets" {}\n');
  writeFileSync(join(root, "legacy-tf", "terraform.tfstate"), "{}\n");
  writeFileSync(join(root, "carve-report.json"), JSON.stringify(REPORT));

  const chantRoot = join(root, "app", "node_modules", "@intentius", "chant");
  mkdirSync(join(chantRoot, "bin"), { recursive: true });
  writeFileSync(
    join(chantRoot, "package.json"),
    JSON.stringify({ name: "@intentius/chant", version: "9.9.9", main: "index.js", bin: { chant: "bin/chant.mjs" } }),
  );
  writeFileSync(join(chantRoot, "index.js"), "export default {};\n");
  const bin = join(chantRoot, "bin", "chant.mjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "argv.log"))}, JSON.stringify(argv) + "\\n");
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
if (argv[0] === "carve" && argv[1] === "emit") {
  const out = flag("--output");
  const report = flag("--report");
  // Real chant writes --report BEFORE it creates --output (verified against
  // 0.44.4), so this throws unless behold made the directory first.
  writeFileSync(report, JSON.stringify({ target: flag("--select"), inbound: [{ direction: "inbound", survivor: "aws_lambda_function.api", carved: flag("--select") }], outbound: [] }, null, 2));
  mkdirSync(join(out, "src"), { recursive: true });
  writeFileSync(join(out, "src", "assets.ts"), "export const assets = new Bucket({});\\n");
  writeFileSync(join(out, "package.json"), '{"name":"chant-carveout"}');
  writeFileSync(join(out, "tsconfig.json"), "{}");
  console.log("Carved " + flag("--select") + " (peelability 88) — observe position, reversible.");
  console.log("  Emitted: " + join(out, "src", "assets.ts"));
  process.exit(0);
}
if (argv[0] === "carve" && argv[1] === "bridge") {
  if (argv.includes("--apply-rewrites")) { console.error("behold must never pass --apply-rewrites"); process.exit(3); }
  const out = flag("--output");
  const slug = String(flag("--select")).replace(/[^A-Za-z0-9_]+/g, "-");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, slug + "-runbook.md"), "# Carve-out\\n\\n## 2. Stop Terraform managing it\\n    terraform state rm " + flag("--select") + "\\n");
  writeFileSync(join(out, slug + "-datasources.tf"), 'data "aws_s3_bucket" "assets" {}\\n');
  writeFileSync(join(out, slug + "-bridge.patch"), "diff --git a/storage.tf b/storage.tf\\n");
  console.log("Wrote proposals to " + out);
  process.exit(0);
}
if (argv[0] === "lint") {
  console.log("  5:1  warning  Exported declarable 'assets' is never referenced.  COR004");
  console.log("\\u26a0 1 warnings");
  process.exit(0);
}
if (argv[0] === "lifecycle" && argv[1] === "diff") {
  // The observe beat's read (#254, chant#1647): record the endpoint the spawn
  // was handed, then answer with whatever the test canned.
  writeFileSync(${JSON.stringify(join(root, "env.log"))}, process.env.AWS_ENDPOINT_URL || "");
  console.log(readFileSync(${JSON.stringify(join(root, "diff-answer.json"))}, "utf8"));
  process.exit(0);
}
console.error("fake chant: unexpected " + argv.join(" "));
process.exit(2);
`,
  );
  chmodSync(bin, 0o755);

  return {
    root,
    demo: {
      root,
      from: join(root, "legacy-tf"),
      state: join(root, "legacy-tf", "terraform.tfstate"),
      project: join(root, "app"),
      out: join(root, "app", "carveout"),
    },
    argv: () =>
      readFileSync(join(root, "argv.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]),
  };
}

describe("insideDemo — the containment check", () => {
  it("accepts a path under the root and refuses everything else", () => {
    expect(insideDemo("/demo", "/demo/app/carveout")).toBe(true);
    expect(insideDemo("/demo", "/demo")).toBe(false); // the root itself is not "inside" it
    expect(insideDemo("/demo", "/demo/../elsewhere")).toBe(false);
    expect(insideDemo("/demo", "/etc/passwd")).toBe(false);
  });
});

describe("selectFromReport — membership, not syntax", () => {
  it("accepts an address the report ranks", () => {
    expect(selectFromReport(REPORT, "aws_s3_bucket.assets")).toBe("aws_s3_bucket.assets");
  });
  it("refuses anything the report doesn't rank, however well-formed", () => {
    expect(selectFromReport(REPORT, "aws_s3_bucket.other")).toBeNull();
    expect(selectFromReport(REPORT, "; rm -rf /")).toBeNull();
    expect(selectFromReport(REPORT, "../../etc/passwd")).toBeNull();
    expect(selectFromReport(REPORT, 42)).toBeNull();
    expect(selectFromReport(undefined, "aws_s3_bucket.assets")).toBeNull();
  });
});

describe("carveWriteBlock", () => {
  it("refuses with no demo at all — the actions don't exist outside one", () => {
    expect(carveWriteBlock(undefined)).toContain("behold demo carve");
  });
  it("refuses an output directory outside the copy", () => {
    const d = fakeDemo();
    expect(carveWriteBlock({ ...d.demo, out: "/tmp/somewhere-else" })).toContain("outside the demo copy");
    rmSync(d.root, { recursive: true, force: true });
  });
  it("passes on a real copy", () => {
    const d = fakeDemo();
    expect(carveWriteBlock(d.demo)).toBeNull();
    rmSync(d.root, { recursive: true, force: true });
  });
});

describe("carveSlug / shortenIn", () => {
  it("matches chant's own artifact naming", () => {
    expect(carveSlug("aws_s3_bucket.assets")).toBe("aws_s3_bucket-assets");
    expect(carveSlug("module.cdn")).toBe("module-cdn");
  });
  it("takes the copy's prefix off an echoed path, and leaves plain flags alone", () => {
    expect(shortenIn("/demo/legacy-tf", "/demo")).toBe("legacy-tf");
    expect(shortenIn("/demo", "/demo")).toBe(".");
    expect(shortenIn("--select", "/demo")).toBe("--select");
    expect(shortenIn("/elsewhere/tf", "/demo")).toBe("/elsewhere/tf");
  });
});

describe("readArtifacts", () => {
  it("reads relative to the copy, skips node_modules and dotfiles, and honours the filter", () => {
    const d = fakeDemo();
    mkdirSync(join(d.demo.out, "src"), { recursive: true });
    mkdirSync(join(d.demo.out, "node_modules"), { recursive: true });
    writeFileSync(join(d.demo.out, "src", "a.ts"), "a");
    writeFileSync(join(d.demo.out, ".hidden"), "h");
    writeFileSync(join(d.demo.out, "node_modules", "b.ts"), "b");
    writeFileSync(join(d.demo.out, "notes.md"), "m");
    const found = readArtifacts(d.demo, d.demo.out, (rel) => rel.endsWith(".ts"));
    expect(found.map((a) => a.path)).toEqual(["app/carveout/src/a.ts"]);
    expect(found[0].kind).toBe("ts");
    expect(found[0].truncated).toBe(false);
    rmSync(d.root, { recursive: true, force: true });
  });
});

describe("runCarveEmit — against a fake project-local chant", () => {
  let d: ReturnType<typeof fakeDemo>;
  beforeAll(async () => {
    d = fakeDemo();
  });
  afterAll(() => rmSync(d.root, { recursive: true, force: true }));

  it("builds the offline argv, creates the output dir first, and reads the result back", async () => {
    const result = await runCarveEmit(d.demo, "aws_s3_bucket.assets");
    expect("ok" in result && result.ok).toBe(true);
    if (!("ok" in result) || !result.ok) return;

    const [emitArgv, lintArgv] = d.argv();
    expect(emitArgv.slice(0, 2)).toEqual(["carve", "emit"]);
    expect(emitArgv).toContain("--state"); // offline: the tfstate, never --env
    expect(emitArgv).not.toContain("--env");
    expect(emitArgv[emitArgv.indexOf("--select") + 1]).toBe("aws_s3_bucket.assets");
    expect(emitArgv[emitArgv.indexOf("--output") + 1]).toBe(d.demo.out);

    // #254 clause 4: the gate shown is lint, and chant build is never run.
    expect(lintArgv).toEqual(["lint", "carveout/src"]);
    expect(d.argv().some((a) => a[0] === "build")).toBe(false);
    expect(result.lint.ok).toBe(true);
    expect(result.buildCaveat).toContain("chant#1637");

    // The echoed command is retypeable — no absolute host paths in it.
    expect(result.command).toContain("--output app/carveout");
    expect(result.command).not.toContain(d.root);
    expect(result.output).not.toContain(d.root);

    expect(result.artifacts.map((a) => a.path)).toContain("app/carveout/src/assets.ts");
    // Emitted source sorts above the scaffolding.
    expect(result.artifacts[0].path).toBe("app/carveout/src/assets.ts");
    expect((result.boundary as { target: string }).target).toBe("aws_s3_bucket.assets");
  });
});

describe("runCarveObserve — the observe beat (#254, chant#1647)", () => {
  let d: ReturnType<typeof fakeDemo>;
  const live = { container: "behold-carve-floci", port: 4602, endpoint: "http://localhost:4602", applied: [] };
  beforeAll(() => {
    d = fakeDemo();
  });
  afterAll(() => rmSync(d.root, { recursive: true, force: true }));

  it("refuses on a non-live boot — there is no live to read", async () => {
    const r = await runCarveObserve(d.demo, "aws_s3_bucket.assets");
    expect("ok" in r && r.ok).toBe(false);
    if ("ok" in r && !r.ok) expect(r.refusal.remedy).toContain("--live");
  });

  it("refuses before Emit — observe reads the carveout emit writes", async () => {
    const r = await runCarveObserve({ ...d.demo, live }, "aws_s3_bucket.assets");
    expect("ok" in r && r.ok).toBe(false);
    if ("ok" in r && !r.ok) expect(r.refusal.remedy).toContain("Emit");
  });

  it("reads the carveout with the endpoint pointed at the scratch Floci, and reports the observed verdict", async () => {
    await runCarveEmit(d.demo, "aws_s3_bucket.assets");
    writeFileSync(
      join(d.root, "diff-answer.json"),
      JSON.stringify({
        environment: "prod",
        lexicons: {
          aws: {
            resources: { missing: [], orphan: [], unchanged: [], unobserved: [], queried: { assets: "cloudcontrol:GetResource:AWS::S3::Bucket:acme-platform-assets-prod" } },
            observed: { assets: { type: "AWS::S3::Bucket", physicalId: "acme-platform-assets-prod", status: "EXTERNAL", ownership: "foreign" } },
          },
        },
      }),
    );
    const r = await runCarveObserve({ ...d.demo, live }, "aws_s3_bucket.assets");
    expect("ok" in r && r.ok).toBe(true);
    if (!("ok" in r) || !r.ok) return;
    expect(r).toMatchObject({
      entity: "assets",
      verdict: "observed",
      status: "EXTERNAL",
      ownership: "foreign",
      physicalId: "acme-platform-assets-prod",
      queried: "cloudcontrol:GetResource:AWS::S3::Bucket:acme-platform-assets-prod",
    });
    // The argv is the diff, the spawn got the scratch endpoint, and the echoed
    // command is retypeable without the host's tmpdir in it.
    const diffArgv = d.argv().find((a) => a[0] === "lifecycle");
    expect(diffArgv).toEqual(["lifecycle", "diff", "prod", "--live", "--json"]);
    expect(readFileSync(join(d.root, "env.log"), "utf8")).toBe(live.endpoint);
    expect(r.command).toContain(live.endpoint);
    expect(r.command).toContain("app/carveout");
    expect(r.command).not.toContain(d.root);
  });

  it("a miss stays a miss — the verdict is chant's, never invented here", async () => {
    writeFileSync(
      join(d.root, "diff-answer.json"),
      JSON.stringify({ environment: "prod", lexicons: { aws: { resources: { missing: ["assets"], queried: { assets: "cloudcontrol:GetResource:AWS::S3::Bucket:acme-platform-assets-prod" } }, observed: {} } } }),
    );
    const r = await runCarveObserve({ ...d.demo, live }, "aws_s3_bucket.assets");
    expect("ok" in r && r.ok).toBe(true);
    if (!("ok" in r) || !r.ok) return;
    expect(r.verdict).toBe("missing");
    expect(r.queried).toContain("AWS::S3::Bucket");
  });

  it("#311: a stacked target's {stacks} shape refuses — it never reads as a missing verdict", async () => {
    writeFileSync(
      join(d.root, "diff-answer.json"),
      JSON.stringify({ environment: "prod", stacks: { network: { lexicons: { aws: { resources: {}, observed: {} } } } } }),
    );
    const r = await runCarveObserve({ ...d.demo, live }, "aws_s3_bucket.assets");
    expect("ok" in r && r.ok).toBe(false);
    if ("ok" in r && !r.ok) {
      expect(r.refusal.error).toContain("stacks");
      expect(r.refusal.error).not.toContain("missing");
    }
  });
});

describe("runCarveBridge — against a fake project-local chant", () => {
  it("never passes --apply-rewrites, and splits the runbook out from the proposals", async () => {
    const d = fakeDemo();
    const result = await runCarveBridge(d.demo, "aws_s3_bucket.assets");
    expect("ok" in result && result.ok).toBe(true);
    if (!("ok" in result) || !result.ok) return;
    const [argv] = d.argv();
    expect(argv.slice(0, 2)).toEqual(["carve", "bridge"]);
    // The fake exits 3 if it ever sees the flag, so an ok result is itself the
    // proof — asserted directly too, because this is the whole safety claim.
    expect(argv).not.toContain("--apply-rewrites");
    expect(result.runbook?.path).toBe("app/carveout/aws_s3_bucket-assets-runbook.md");
    expect(result.proposals.map((a) => a.path).sort()).toEqual([
      "app/carveout/aws_s3_bucket-assets-bridge.patch",
      "app/carveout/aws_s3_bucket-assets-datasources.tf",
    ]);
    rmSync(d.root, { recursive: true, force: true });
  });

  it("refuses politely when chant fails, in #193's shape", async () => {
    const d = fakeDemo();
    const result = await runCarveBridge(d.demo, "random_pet.suffix");
    // The fake writes for any select; make it fail by pointing `from` at a
    // directory that isn't there — the same class of failure a missing HCL
    // parser produces.
    const broken = await runCarveBridge({ ...d.demo, from: join(d.root, "nope") }, "random_pet.suffix");
    expect("ok" in result && result.ok).toBe(true);
    expect("ok" in broken && broken.ok).toBe(false);
    if ("ok" in broken && !broken.ok) {
      expect(broken.refusal.code).toBe("read-only");
      expect(broken.refusal.error).toContain("no Terraform estate");
    }
    rmSync(d.root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// The HTTP half: the two routes exist only in carve mode, act only inside a
// demo, and refuse everything else politely.
// ---------------------------------------------------------------------------
function appFor(demo?: CarveDemo, reportPath?: string) {
  const dir = demo ? demo.root : mkdtempSync(join(tmpdir(), "behold-carve-plain-"));
  const report = reportPath ?? join(dir, "carve-report.json");
  writeFileSync(report, JSON.stringify(REPORT));
  const broadcaster = new Broadcaster();
  return createApp(
    { projectDir: dir, carveReport: report, ...(demo ? { carveDemo: demo } : {}), port: 0 },
    broadcaster,
    new FrameBuffer(),
    new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }),
  );
}

const post = (app: ReturnType<typeof appFor>, path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  app.request(path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("POST /api/carve/{emit,bridge} — the write boundary over HTTP", () => {
  it("is absent from an ordinary project serve", async () => {
    const broadcaster = new Broadcaster();
    const app = createApp({ projectDir: "/work/loomster", port: 0 }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: "/work/loomster", broadcaster, onDone: () => {} }));
    expect((await post(app, "/api/carve/emit", { select: "aws_s3_bucket.assets" })).status).toBe(404);
  });

  it("refuses in plain carve mode — the steps exist only inside a demo copy", async () => {
    const app = appFor();
    const res = await post(app, "/api/carve/emit", { select: "aws_s3_bucket.assets" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string; remedy: string };
    expect(body.code).toBe("read-only");
    expect(body.remedy).toContain("behold demo carve");
  });

  it("refuses a select the report doesn't rank", async () => {
    const d = fakeDemo();
    const res = await post(appFor(d.demo), "/api/carve/emit", { select: "aws_s3_bucket.somebody_elses" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("carve-select");
    rmSync(d.root, { recursive: true, force: true });
  });

  it("refuses a non-JSON body and an oversized one", async () => {
    const d = fakeDemo();
    const app = appFor(d.demo);
    expect((await post(app, "/api/carve/bridge", "select=x", { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(app, "/api/carve/bridge", JSON.stringify({ select: "x".repeat(5000) }))).status).toBe(413);
    rmSync(d.root, { recursive: true, force: true });
  });

  it("runs the step and answers the artifacts when the demo is real", async () => {
    const d = fakeDemo();
    const res = await post(appFor(d.demo), "/api/carve/emit", { select: "aws_s3_bucket.assets" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { select: string; artifacts: Array<{ path: string }>; lint: { ok: boolean } };
    expect(body.select).toBe("aws_s3_bucket.assets");
    expect(body.artifacts.map((a) => a.path)).toContain("app/carveout/src/assets.ts");
    expect(body.lint.ok).toBe(true);
    rmSync(d.root, { recursive: true, force: true });
  });
});

describe("GET /api/project — the demo block the stepper gates its buttons on", () => {
  it("says runnable, with copy-relative labels, inside a demo", async () => {
    const d = fakeDemo();
    const body = (await (await appFor(d.demo).request("/api/project")).json()) as {
      carve: { demo: { runnable: boolean; outLabel: string; fromLabel: string; buildCaveat: string } };
    };
    expect(body.carve.demo.runnable).toBe(true);
    expect(body.carve.demo.outLabel).toBe("app/carveout");
    expect(body.carve.demo.fromLabel).toBe("legacy-tf");
    expect(body.carve.demo.buildCaveat).toContain("chant#1637");
    rmSync(d.root, { recursive: true, force: true });
  });

  it("says nothing at all outside one, so the stepper greys its runs out", async () => {
    const body = (await (await appFor().request("/api/project")).json()) as { carve: { demo: unknown } };
    expect(body.carve.demo).toBeNull();
  });

  it("carries the degraded note when the boot's own advisor run failed", async () => {
    const d = fakeDemo();
    const app = appFor({ ...d.demo, degraded: "chant carve advise exited 1 — showing the committed report." });
    const project = (await (await app.request("/api/project")).json()) as { carve: { demo: { degraded: string } } };
    expect(project.carve.demo.degraded).toContain("committed report");
    const graph = (await (await app.request("/api/graph")).json()) as { meta: { note: string } };
    expect(graph.meta.note).toContain("Degraded:");
    rmSync(d.root, { recursive: true, force: true });
  });
});
