import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fakeKubeconfig } from "@intentius/chant-k8s-client/testing";
import { detectSubstrates, projectLexicons } from "./substrates.ts";

// Hermetic where it matters: the fly/github/temporal pills (#74) read only the
// project dir + env, never docker/k3d — the probe-backed pills are asserted by
// presence-shape only, since their status depends on the host.
//
// The helm pill's ambient context is a kubeconfig read since #231, so those
// cases point KUBECONFIG at a fixture file: the developer's real cluster is
// never read and nothing is contacted. KUBECONFIG is restored either way, since
// leaving it set would leak into every later case in the run.
let dir: string;
let savedKubeconfig: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "behold-substrates-"));
  savedKubeconfig = process.env.KUBECONFIG;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FLY_FLAPS_BASE_URL;
  if (savedKubeconfig === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = savedKubeconfig;
});

function config(lexicons: string[], extra = ""): void {
  writeFileSync(join(dir, "chant.config.ts"), `export default {\n  lexicons: [${lexicons.map((l) => `"${l}"`).join(", ")}],\n${extra}\n};\n`);
}

const byName = async (name: string) => (await detectSubstrates(dir)).find((s) => s.name === name);

describe("projectLexicons", () => {
  it("scans the declared lexicon list, empty when unreadable", () => {
    config(["aws", "k8s"]);
    expect(projectLexicons(dir)).toEqual(["aws", "k8s"]);
    expect(projectLexicons(join(dir, "nope"))).toEqual([]);
  });
});

describe("fly pill (#74)", () => {
  it("appears for a fly-lexicon project, naming the targeted endpoint when set", { timeout: 20_000 }, async () => {
    config(["fly"]);
    process.env.FLY_FLAPS_BASE_URL = "http://localhost:4280";
    const fly = await byName("fly");
    expect(fly?.status).toBe("on-demand");
    expect(fly?.detail).toContain("http://localhost:4280");
  });

  it("says real Fly when the var is unset, and is absent without the lexicon", { timeout: 20_000 }, async () => {
    config(["fly"]);
    expect((await byName("fly"))?.detail).toContain("real Fly");
    config(["aws"]);
    expect(await byName("fly")).toBeUndefined();
  });
});

describe("github pill (#74)", () => {
  it("appears when generated workflows are committed, read-only, status by the HOST's gh auth", { timeout: 20_000 }, async () => {
    config(["aws", "github"]);
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    const gh = await byName("github");
    expect(gh).toBeDefined();
    expect(gh?.bringUp).toBeUndefined();
    // Since #164 the pill reports whether the DISPATCH is available, which is
    // a fact about the host's `gh` login — authenticated here, absent on a CI
    // runner. Assert the coherent pairing, not one machine's answer (this
    // exact assertion was 'on-demand' and failed on CI's unauthenticated gh).
    if (gh?.status === "on-demand") {
      expect(gh.detail).toContain("dispatch via your gh login");
    } else {
      expect(gh?.status).toBe("blocked");
      expect(gh?.detail).toMatch(/gh not (installed|authenticated)/);
    }
  });

  it("absent without .github/workflows — the lexicon alone commits nothing", { timeout: 20_000 }, async () => {
    config(["aws", "github"]);
    expect(await byName("github")).toBeUndefined();
  });
});

describe("helm pill's ambient context (#146, #231)", () => {
  /** Write a kubeconfig naming one context and point KUBECONFIG at it. */
  function kubeconfig(context: string): void {
    const path = join(dir, `${context}.yaml`);
    writeFileSync(path, fakeKubeconfig({ contexts: [{ name: context }], currentContext: context }));
    process.env.KUBECONFIG = path;
  }

  it("names the kubeconfig's current-context, read from the file rather than shelled out", { timeout: 20_000 }, async () => {
    config(["helm"]);
    kubeconfig("k3d-demo");
    const pill = await byName("helm");
    // helm itself is still a binary probe, and CI runners without it report
    // `unknown` — assert the coherent pairing, not one machine's answer.
    if (pill?.status === "unknown") expect(pill.detail).toBe("helm not installed");
    else {
      expect(pill?.status).toBe("on-demand");
      expect(pill?.detail).toContain("context k3d-demo");
    }
  });

  it("prefers the project's bound context over the ambient one", { timeout: 20_000 }, async () => {
    // The kubemicrovm-ops regression: probing only ambient named whatever
    // cluster the operator's shell last pointed at.
    config(["helm"]);
    kubeconfig("prod-eks");
    const pill = (await detectSubstrates(dir, false, "k3d-kubemicrovm-local")).find((s) => s.name === "helm");
    if (pill?.status !== "unknown") {
      expect(pill?.detail).toContain("context k3d-kubemicrovm-local (bound)");
      expect(pill?.detail).not.toContain("prod-eks");
    }
  });

  it("says so when there is no kube context at all — no kubeconfig is not a crash", { timeout: 20_000 }, async () => {
    config(["helm"]);
    // Two paths that do not exist: the client's multi-file path, so nothing
    // falls back to the developer's ~/.kube/config.
    process.env.KUBECONFIG = [join(dir, "nope-a.yaml"), join(dir, "nope-b.yaml")].join(delimiter);
    const pill = await byName("helm");
    if (pill?.status !== "unknown") {
      expect(pill?.status).toBe("blocked");
      expect(pill?.detail).toBe("no kube context");
    }
  });
});

describe("temporal pill (#74)", () => {
  it("blocked with the actionable message when no temporal.profiles is declared", { timeout: 20_000 }, async () => {
    // kubemicrovm-ops' live failure: chant run refuses with exactly this gap.
    config(["k8s", "temporal"]);
    const t = await byName("temporal");
    expect(t?.status).toBe("blocked");
    expect(t?.detail).toContain("no temporal.profiles");
  });

  it("on-demand when profiles are declared", { timeout: 20_000 }, async () => {
    config(["k8s", "temporal"], `  temporal: {\n    profiles: { local: { address: "localhost:7233" } },\n  },`);
    expect((await byName("temporal"))?.status).toBe("on-demand");
  });
});
