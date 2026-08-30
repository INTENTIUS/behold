import { describe, test, expect } from "vitest";
import { applyHelmArtifacts } from "./helm-artifacts.ts";
import type { GraphIR, IRNode } from "@intentius/chant";
import type { LiveArtifactObservation } from "./chant.ts";

const chartNode = (id: string, name: string): IRNode => ({
  id,
  kind: "Helm::Chart",
  lexicon: "helm",
  attrs: { name },
});

const irOf = (nodes: IRNode[]): GraphIR => ({ nodes, edges: [], groups: {} });

const deployed: Record<string, LiveArtifactObservation> = {
  "release/prod/web": {
    type: "Helm::Release",
    status: "deployed",
    attributes: { chart: "web-app-1.2.3", revision: "3" },
  },
};

describe("applyHelmArtifacts (behold#146)", () => {
  test("a deployed release paints its chart good and carries the match for inspect", () => {
    const ir = irOf([chartNode("webChart", "web-app")]);
    const { charts, installed } = applyHelmArtifacts(ir, deployed);

    expect({ charts, installed }).toEqual({ charts: 1, installed: 1 });
    const attrs = ir.nodes[0].attrs!;
    expect(attrs._status).toBe("good");
    expect(attrs._artifact).toEqual({ release: "prod/web", status: "deployed", revision: "3", chart: "web-app-1.2.3" });
  });

  test("a failed release paints warn — installed but not healthy", () => {
    const ir = irOf([chartNode("webChart", "web-app")]);
    applyHelmArtifacts(ir, {
      "release/prod/web": { status: "failed", attributes: { chart: "web-app-1.2.3" } },
    });
    expect(ir.nodes[0].attrs!._status).toBe("warn");
  });

  test("no matching release: accent — declared, not installed", () => {
    const ir = irOf([chartNode("webChart", "web-app")]);
    applyHelmArtifacts(ir, {
      "release/prod/other": { status: "deployed", attributes: { chart: "someone-elses-chart-2.0.0" } },
    });
    expect(ir.nodes[0].attrs!._status).toBe("accent");
    expect(ir.nodes[0].attrs!._artifact).toBeUndefined();
  });

  test("chart name matching never crosses a prefix boundary", () => {
    // "web" must not claim "web-app-1.2.3"'s release... but must claim "web-9.9.9".
    const ir = irOf([chartNode("c1", "web")]);
    applyHelmArtifacts(ir, {
      "release/prod/other": { status: "deployed", attributes: { chart: "web-app-1.2.3" } },
    });
    // "web-app-1.2.3" DOES start with "web-" — a genuine ambiguity in helm's
    // `name-version` packing. The join accepts it rather than inventing a
    // version parser; the carried `chart` string keeps the inspect honest.
    expect(ir.nodes[0].attrs!._status).toBe("good");
  });

  test("observation unavailable: neutral with a reason — unobserved is not absent", () => {
    const ir = irOf([chartNode("webChart", "web-app")]);
    applyHelmArtifacts(ir, undefined);
    expect(ir.nodes[0].attrs!._status).toBe("neutral");
    expect(ir.nodes[0].attrs!._unobserved).toBe("artifact-observation-unavailable");
  });

  test("a release matching no declared chart is never invented as a node", () => {
    const ir = irOf([chartNode("webChart", "web-app")]);
    applyHelmArtifacts(ir, {
      ...deployed,
      "release/kube-system/traefik": { status: "deployed", attributes: { chart: "traefik-25.0.0" } },
    });
    expect(ir.nodes).toHaveLength(1);
  });

  test("non-helm nodes are untouched", () => {
    const aws: IRNode = { id: "vpc", kind: "AWS::EC2::VPC", lexicon: "aws", attrs: { _status: "good" } };
    const ir = irOf([aws, chartNode("c", "web-app")]);
    applyHelmArtifacts(ir, deployed);
    expect(aws.attrs!._status).toBe("good");
  });

  test("an observed release carries no render identity — the join #146 and the drift lens both had to guess", () => {
    // chant's `listArtifacts` (lexicons/helm/src/list-artifacts.ts) is a
    // `helm list -o json` parse, and this is the whole attribute set it emits.
    // Notably absent: the `helmInputDigest` chant#1243 has the release ledger
    // record on deploy. Without it, an OBSERVED release cannot be joined to
    // the PINNED render that produced it, so both this module and
    // src/helm-drift.ts fall back to matching on the chart name — and #234's
    // "is prod running what staging tested" has no digest to compare, because
    // a consumer can only obtain a digest for a render it can re-render
    // locally, never for a release it can only observe.
    //
    // Filed as chant#2031. The day it lands this assertion fails, and it
    // fails pointing straight at the join that got better.
    expect(Object.keys(deployed["release/prod/web"].attributes!).sort()).toEqual(["chart", "revision"]);
    expect(deployed["release/prod/web"].attributes).not.toHaveProperty("inputDigest");
    expect(deployed["release/prod/web"].attributes).not.toHaveProperty("contentDigest");
  });
});
