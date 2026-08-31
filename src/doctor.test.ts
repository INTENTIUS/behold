import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { diagnose, formatReport, type DoctorProbes, type DoctorReport, type DoctorCheck } from "./doctor.ts";
import type { Kubeconfig } from "./k8s-target.ts";
import type { Substrate } from "./substrates.ts";

// Fixtures are built in the OS tmpdir rather than pointed at the bundled
// examples: example-writes' node_modules is intentionally absent in a fresh
// checkout and intentionally present after `just example-install`, so a test
// keyed on either state passes only half the time. A tmp fixture states which
// case it is.
const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

/** A fixture directory: `{ "rel/path": contents }`, parents created. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-doctor-"));
  made.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

/** A fake installed package under the fixture's own node_modules — enough for
 * Node's resolver to find it (an entry point that exists) and for the manifest
 * walk to read its version. */
function installed(name: string, version: string, bin?: string): Record<string, string> {
  const root = `node_modules/${name}`;
  return {
    [`${root}/package.json`]: JSON.stringify({ name, version, main: "index.js", ...(bin ? { bin: { chant: bin } } : {}) }),
    [`${root}/index.js`]: "",
    ...(bin ? { [`${root}/${bin}`]: "#!/usr/bin/env node\n" } : {}),
  };
}

const CHANT = installed("@intentius/chant", "0.53.1", "bin/chant");

const kubeconfig = (over: Partial<Kubeconfig> = {}): Kubeconfig => ({
  contexts: new Map(),
  servers: new Map(),
  ...over,
});

/** Probes for a machine with nothing running and nothing installed — the
 * default for these tests, so no result depends on the host's Docker or
 * kubeconfig. */
const probes = (over: DoctorProbes = {}): DoctorProbes => ({
  loadKubeconfig: async () => kubeconfig(),
  detectSubstrates: async () => [],
  ...over,
});

const up: Substrate[] = [{ name: "docker", label: "Docker", status: "up", detail: "daemon running" }];

const by = (report: DoctorReport, name: DoctorCheck["name"]): DoctorCheck => report.checks.find((c) => c.name === name)!;

describe("diagnose", () => {
  it("passes every line for a healthy project — installed chant + lexicon, an env, committed Ops", async () => {
    const dir = fixture({
      "chant.config.ts": `export default { lexicons: ["aws"], environments: ["prod"], sourceDir: "src" };`,
      "package.json": JSON.stringify({ name: "healthy", dependencies: { "@intentius/chant": "^0.53.1" } }),
      "src/main.ts": "",
      "ops/deploy.op.ts": `export const op = { name: "prod-apply", kind: ApplyOp };`,
      ...CHANT,
      ...installed("@intentius/chant-lexicon-aws", "0.53.1"),
    });

    const report = await diagnose(dir, probes({ detectSubstrates: async () => up }));

    expect(report.ok).toBe(true);
    expect(report.kind).toBe("project");
    expect(report.checks.map((c) => c.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass", "pass"]);
    expect(by(report, "chant").detail).toContain("chant 0.53.1");
    expect(by(report, "lexicons").detail).toContain("aws 0.53.1");
    expect(by(report, "envs").detail).toContain("prod");
    expect(by(report, "ops").detail).toContain("prod-apply (apply)");
    expect(report.checks.every((c) => c.fix === undefined)).toBe(true);
  });

  it("fails with one line, and the fix, for a directory that is no project at all (#193's dead end)", async () => {
    const report = await diagnose(fixture({ "notes.txt": "hello" }), probes());

    expect(report.ok).toBe(false);
    expect(report.kind).toBe("none");
    expect(report.checks).toHaveLength(1);
    expect(by(report, "project").status).toBe("fail");
    expect(by(report, "project").fix).toContain("behold demo");
  });

  it("fails, naming npm install, when the project's own chant and lexicons aren't installed", async () => {
    const dir = fixture({
      "chant.config.ts": `export default { lexicons: ["aws"], environments: ["prod"] };`,
      "package.json": JSON.stringify({ name: "uninstalled", dependencies: { "@intentius/chant": "^0.53.1" } }),
    });

    const report = await diagnose(dir, probes());

    expect(report.ok).toBe(false);
    expect(by(report, "chant").status).toBe("fail");
    expect(by(report, "chant").detail).toContain("no chant installed");
    expect(by(report, "chant").fix).toContain("npm install");
    expect(by(report, "lexicons").status).toBe("fail");
    expect(by(report, "lexicons").fix).toContain("npm install");
    // The act loop goes with it — chant's MCP is served by the project's chant.
    expect(by(report, "ops").detail).toContain("chant MCP unavailable");
  });

  it("warns rather than fails for a k8s project with no kube context — the declared graph still serves", async () => {
    const dir = fixture({
      "chant.config.ts": `export default { lexicons: ["k8s"], k8s: { profiles: { local: { context: "k3d-demo" } } } };`,
      ...CHANT,
      ...installed("@intentius/chant-lexicon-k8s", "0.53.1"),
    });

    const report = await diagnose(dir, probes());

    expect(report.ok).toBe(true);
    expect(by(report, "kube").status).toBe("warn");
    expect(by(report, "kube").detail).toContain("no kubeconfig readable");
    // Since #231 the fix names the kubeconfig, not kubectl — behold reads the
    // file itself now, so "install kubectl" was advice for a problem it no
    // longer has.
    expect(by(report, "kube").fix).toContain("KUBECONFIG");
    expect(by(report, "kube").fix).not.toContain("kubectl");
  });

  it("reports the bound context and its apiserver when the kubeconfig carries it", async () => {
    const dir = fixture({
      "chant.config.ts": `export default { lexicons: ["k8s"], k8s: { profiles: { local: { context: "k3d-demo" } } } };`,
      ...CHANT,
      ...installed("@intentius/chant-lexicon-k8s", "0.53.1"),
    });
    const kc = kubeconfig({
      contexts: new Map([["k3d-demo", "k3d-demo-cluster"]]),
      servers: new Map([["k3d-demo-cluster", "https://127.0.0.1:6443"]]),
      currentContext: "k3d-demo",
    });

    const report = await diagnose(dir, probes({ loadKubeconfig: async () => kc }));

    expect(by(report, "kube").status).toBe("pass");
    expect(by(report, "kube").detail).toBe("bound local: k3d-demo at https://127.0.0.1:6443");
    // The env picker infers k8s.profiles keys when no environments array is
    // declared (#191) — the same inference the server's picker makes.
    expect(by(report, "envs").detail).toContain("local");
  });

  it("warns when the ambient current-context differs from the declared binding — chant refuses the live read", async () => {
    const dir = fixture({
      "chant.config.ts": `export default { lexicons: ["k8s"], k8s: { profiles: { local: { context: "k3d-demo" } } } };`,
      ...CHANT,
      ...installed("@intentius/chant-lexicon-k8s", "0.53.1"),
    });
    const kc = kubeconfig({
      contexts: new Map([
        ["k3d-demo", "k3d-demo-cluster"],
        ["prod-eks", "prod"],
      ]),
      servers: new Map([
        ["k3d-demo-cluster", "https://127.0.0.1:6443"],
        ["prod", "https://prod.example"],
      ]),
      currentContext: "prod-eks",
    });

    const report = await diagnose(dir, probes({ loadKubeconfig: async () => kc }));

    expect(report.ok).toBe(true);
    expect(by(report, "kube").status).toBe("warn");
    expect(by(report, "kube").detail).toContain("ambient current-context is prod-eks");
    expect(by(report, "kube").fix).toBe("Run `kubectl config use-context k3d-demo` before the live overlay.");
  });

  it("warns, never fails, on a down substrate — and names its bring-up", async () => {
    const dir = fixture({
      "chant.config.ts": `export default { lexicons: ["aws"], environments: ["prod"] };`,
      ...CHANT,
      ...installed("@intentius/chant-lexicon-aws", "0.53.1"),
    });
    const down: Substrate[] = [
      { name: "docker", label: "Docker", status: "up", detail: "daemon running" },
      { name: "floci", label: "Floci", status: "down", detail: "not running", bringUp: { label: "local-up", cmd: "bash", args: ["scripts/local/local-up.sh"] } },
    ];

    const report = await diagnose(dir, probes({ detectSubstrates: async () => down }));

    expect(report.ok).toBe(true);
    expect(by(report, "substrates").status).toBe("warn");
    expect(by(report, "substrates").detail).toBe("Docker up, Floci down");
    expect(by(report, "substrates").fix).toContain("bash scripts/local/local-up.sh");
  });

  it("says plainly that no declared envs means no live overlay", async () => {
    const dir = fixture({ "chant.config.ts": `export default { lexicons: [] };`, ...CHANT });

    const report = await diagnose(dir, probes());

    expect(report.ok).toBe(true);
    expect(by(report, "envs").status).toBe("warn");
    expect(by(report, "envs").detail).toContain("no live overlay");
  });

  it("warns when the project ships no committed Ops — drift visible, nothing to trigger", async () => {
    const dir = fixture({ "chant.config.ts": `export default { lexicons: [], environments: ["prod"] };`, ...CHANT });

    const report = await diagnose(dir, probes());

    expect(by(report, "ops").status).toBe("warn");
    expect(by(report, "ops").fix).toContain("ApplyOp");
  });

  it("diagnoses an estate root across its members, and points serve at them rather than the root", async () => {
    const dir = fixture({
      ".behold.json": JSON.stringify({ members: ["a", "b"] }),
      "a/chant.config.ts": `export default { lexicons: ["aws"], environments: ["prod"] };`,
      "a/ops/apply.op.ts": `export const op = { name: "a-apply", kind: ApplyOp };`,
      "b/chant.config.ts": `export default { lexicons: ["aws"], environments: ["staging"] };`,
      ...CHANT,
      ...installed("@intentius/chant-lexicon-aws", "0.53.1"),
    });

    const report = await diagnose(dir, probes({ detectSubstrates: async () => up }));

    expect(report.kind).toBe("estate");
    expect(by(report, "project").detail).toContain(".behold.json members): a, b");
    expect(by(report, "chant").detail).toBe("a: chant 0.53.1, b: chant 0.53.1 (behold's floor 0.53.1)");
    expect(by(report, "envs").detail).toContain(`behold serve ${dir}/a ${dir}/b --env prod`);
    expect(by(report, "ops").detail).toContain("a: a-apply (apply)");
  });

  it("detects an estate from npm workspaces when no .behold.json declares members", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "estate", workspaces: ["control-plane", "not-a-project"] }),
      "control-plane/chant.config.ts": `export default { lexicons: [], environments: ["local"] };`,
      "not-a-project/package.json": "{}",
      ...CHANT,
    });

    const report = await diagnose(dir, probes());

    expect(report.kind).toBe("estate");
    // A workspace that isn't a chant project is not a member.
    expect(by(report, "project").detail).toBe("estate of 1 projects (npm workspaces): control-plane");
  });
});

describe("--json", () => {
  it("is a stable shape: behold/dir/kind/ok plus a check per line, keyed by name", async () => {
    const dir = fixture({
      "chant.config.ts": `export default { lexicons: ["aws"], environments: ["prod"] };`,
      "ops/apply.op.ts": `export const op = { name: "prod-apply", kind: ApplyOp };`,
      ...CHANT,
      ...installed("@intentius/chant-lexicon-aws", "0.53.1"),
    });

    const report = await diagnose(dir, probes({ detectSubstrates: async () => up }));
    const round = JSON.parse(JSON.stringify(report)) as DoctorReport;

    expect(Object.keys(round)).toEqual(["behold", "dir", "kind", "ok", "checks"]);
    expect(round.dir).toBe(dir);
    expect(round.kind).toBe("project");
    expect(round.ok).toBe(true);
    expect(round.checks.map((c) => c.name)).toEqual(["project", "chant", "lexicons", "envs", "kube", "substrates", "ops"]);
    for (const c of round.checks) {
      expect(Object.keys(c).filter((k) => k !== "fix")).toEqual(["name", "status", "detail"]);
      expect(["pass", "warn", "fail"]).toContain(c.status);
      expect(typeof c.detail).toBe("string");
    }
    // Every non-pass line carries its one-line fix; a pass never does.
    for (const c of round.checks) expect(c.fix === undefined).toBe(c.status === "pass");
  });
});

describe("formatReport", () => {
  const report: DoctorReport = {
    behold: "0.7.0",
    dir: "/tmp/project",
    kind: "project",
    ok: false,
    checks: [
      { name: "project", status: "pass", detail: "chant project (chant.config.ts)" },
      { name: "chant", status: "fail", detail: "no chant installed — behold shells the project's own chant", fix: "Run `npm install` in /tmp/project" },
      { name: "lexicons", status: "pass", detail: "none declared" },
      { name: "envs", status: "pass", detail: "prod — `behold serve . --env prod` for the live overlay" },
      { name: "kube", status: "pass", detail: "no k8s or helm lexicon — no cluster binding to check" },
      { name: "substrates", status: "warn", detail: "Docker down", fix: "Bring up: Docker (open -a Docker)" },
      { name: "ops", status: "pass", detail: "1 committed: prod-apply (apply); chant MCP unavailable until the project's chant is installed" },
    ],
  };

  it("renders the console report", () => {
    expect(formatReport(report)).toMatchInlineSnapshot(`
      "behold doctor 0.7.0 — /tmp/project

        pass  project     chant project (chant.config.ts)
        fail  chant       no chant installed — behold shells the project's own chant
              fix         Run \`npm install\` in /tmp/project
        pass  lexicons    none declared
        pass  envs        prod — \`behold serve . --env prod\` for the live overlay
        pass  kube        no k8s or helm lexicon — no cluster binding to check
        warn  substrates  Docker down
              fix         Bring up: Docker (open -a Docker)
        pass  ops         1 committed: prod-apply (apply); chant MCP unavailable until the project's chant is installed

        5 pass, 1 warn, 1 fail
      "
    `);
  });
});
