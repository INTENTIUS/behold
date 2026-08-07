import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import type { LiveArtifactObservation } from "./chant.ts";
import { synthesizeHelmReleases, discoverReleaseUnits } from "./helm-releases.ts";

const emptyIr = (): GraphIR => ({ nodes: [], edges: [], groups: {} });

// The kubemicrovm-ops shape: releases installed by component helm-upgrade
// steps, no declared Helm::Chart node anywhere.
const observed: Record<string, LiveArtifactObservation> = {
  "release/cert-manager/cert-manager": {
    type: "Helm::Release",
    status: "deployed",
    attributes: { chart: "cert-manager-v1.21.1", revision: "1" },
  },
  "release/kube-microvm/kube-microvm-operator": {
    type: "Helm::Release",
    status: "deployed",
    attributes: { chart: "kube-microvm-operator-1.0.11", revision: "1" },
  },
  "release/kube-system/traefik": {
    type: "Helm::Release",
    status: "deployed",
    attributes: { chart: "traefik-37.1.1+up37.1.0", revision: "1" },
  },
};

describe("synthesizeHelmReleases", () => {
  it("component-owned releases synthesize good, unowned ones warn (foreign)", () => {
    const ir = emptyIr();
    const owners = new Map([
      ["cert-manager", "operator"],
      ["kube-microvm-operator", "operator"],
    ]);
    expect(synthesizeHelmReleases(ir, observed, owners)).toBe(3);

    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    const cm = byId.get("release/cert-manager/cert-manager")!;
    expect(cm.kind).toBe("Helm::Release");
    expect(cm.attrs?._status).toBe("good");
    expect(cm.attrs?.component).toBe("operator");
    expect(cm.attrs?.namespace).toBe("cert-manager");

    const traefik = byId.get("release/kube-system/traefik")!;
    expect(traefik.attrs?._status).toBe("warn");
    expect(traefik.attrs?._foreignRelease).toBe(true);
  });

  it("a non-deployed status paints warn even when owned", () => {
    const ir = emptyIr();
    synthesizeHelmReleases(
      ir,
      { "release/x/broken": { status: "failed", attributes: { chart: "broken-1.0.0" } } },
      new Map([["broken", "operator"]]),
    );
    expect(ir.nodes[0].attrs?._status).toBe("warn");
  });

  it("a release matching a declared chart is NOT synthesized — the chart card says it", () => {
    const ir: GraphIR = {
      nodes: [{ id: "chart", kind: "Helm::Chart", lexicon: "helm", attrs: { name: "cert-manager" } }],
      edges: [],
      groups: {},
    };
    const added = synthesizeHelmReleases(
      ir,
      { "release/cert-manager/cert-manager": observed["release/cert-manager/cert-manager"] },
      new Map(),
    );
    expect(added).toBe(0);
    expect(ir.nodes).toHaveLength(1);
  });

  it("no observation synthesizes nothing (unobserved ≠ absent)", () => {
    const ir = emptyIr();
    expect(synthesizeHelmReleases(ir, undefined, new Map())).toBe(0);
  });
});

describe("discoverReleaseUnits", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "behold-helm-units-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("scrapes helmUpgrade release literals from *.component.ts, keyed to the component name", () => {
    const comp = join(dir, "src", "components");
    mkdirSync(comp, { recursive: true });
    writeFileSync(
      join(comp, "operator.component.ts"),
      `import { defineComponent } from "@intentius/chant/components";
import { helmUpgrade } from "@intentius/chant-lexicon-helm/components";
export const operator = defineComponent({
  name: "operator",
  deploy: [
    helmUpgrade({
      release: "cert-manager",
      chart: "cert-manager",
      repo: "https://charts.jetstack.io",
    }),
    helmUpgrade({
      release: "kube-microvm-operator",
      chart: "oci://ghcr.io/codriverlabs/helm/kube-microvm-operator",
    }),
  ],
});
`,
    );
    const owners = discoverReleaseUnits(dir);
    expect(owners.get("cert-manager")).toBe("operator");
    expect(owners.get("kube-microvm-operator")).toBe("operator");
  });

  it("a project with no component sources yields an empty map", () => {
    expect(discoverReleaseUnits(dir).size).toBe(0);
  });
});
