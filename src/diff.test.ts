import { describe, it, expect } from "vitest";
import { nodeDiff, nodeObserved, nodeFieldDrift, type LiveDiffJson } from "./diff.ts";

const json: LiveDiffJson = {
  environment: "prod",
  lexicons: {
    aws: {
      resources: {
        missing: ["gone"],
        orphan: ["stray"],
        disappeared: ["vanished"],
        newlyObserved: ["fresh"],
        driftedSinceSnapshot: [
          { name: "store", changes: [{ path: "attributes.tags.env", oldValue: "dev", newValue: "prod" }] },
        ],
        unchanged: ["stable"],
        unobserved: [{ name: "crd-thing", type: "SomeCrd", reason: "unsupported-kind" }],
      },
      observed: {
        store: { type: "AWS::S3::Bucket", status: "CREATE_COMPLETE", physicalId: "my-bucket", attributes: { Region: "us-east-1" } },
      },
    },
  },
};

describe("nodeDiff", () => {
  it("returns drifted with field changes for a resource that drifted since snapshot", () => {
    expect(nodeDiff(json, "store")).toEqual({
      category: "drifted",
      changes: [{ path: "attributes.tags.env", oldValue: "dev", newValue: "prod" }],
    });
  });

  it("classifies presence categories with no field changes", () => {
    expect(nodeDiff(json, "gone")).toEqual({ category: "missing", changes: [] });
    expect(nodeDiff(json, "stray")).toEqual({ category: "orphan", changes: [] });
    expect(nodeDiff(json, "vanished")).toEqual({ category: "disappeared", changes: [] });
    expect(nodeDiff(json, "fresh")).toEqual({ category: "newlyObserved", changes: [] });
    expect(nodeDiff(json, "stable")).toEqual({ category: "unchanged", changes: [] });
  });

  it("returns null for a node absent from the diff", () => {
    expect(nodeDiff(json, "nope")).toBeNull();
  });

  // chant#1168 (#1089): a declared entity chant could not read live state
  // for — its own category, never drift and never a confirmed absence.
  it("classifies an unobserved entity distinctly, carrying the reason", () => {
    expect(nodeDiff(json, "crd-thing")).toEqual({
      category: "unobserved",
      changes: [],
      unobservedReason: "unsupported-kind",
    });
  });

  it("carries unobservedDetail when chant reports one", () => {
    const withDetail: LiveDiffJson = {
      environment: "prod",
      lexicons: {
        aws: { resources: { missing: [], orphan: [], disappeared: [], newlyObserved: [], driftedSinceSnapshot: [], unchanged: [], unobserved: [{ name: "x", reason: "read-failed", detail: "describe-stack-resources timed out" }] } },
      },
    };
    expect(nodeDiff(withDetail, "x")).toEqual({
      category: "unobserved",
      changes: [],
      unobservedReason: "read-failed",
      unobservedDetail: "describe-stack-resources timed out",
    });
  });

  it("is backward compatible with a diff from a chant predating #1168 (no `unobserved` key)", () => {
    const legacy: LiveDiffJson = {
      environment: "prod",
      lexicons: { aws: { resources: { missing: ["gone"], orphan: [], disappeared: [], newlyObserved: [], driftedSinceSnapshot: [], unchanged: [] } } },
    };
    expect(nodeDiff(legacy, "gone")).toEqual({ category: "missing", changes: [] });
  });

  // chant#1180 (#1077): a live, undeclared resource whose owner chain reaches
  // a declared entity — its own category, never orphan and never drift.
  it("classifies a runtime child distinctly, carrying its declared owner", () => {
    const withRuntime: LiveDiffJson = {
      environment: "prod",
      lexicons: {
        k8s: {
          resources: {
            missing: [],
            orphan: ["stray"],
            disappeared: [],
            newlyObserved: [],
            driftedSinceSnapshot: [],
            unchanged: [],
            runtimeChildren: [
              { name: "appDeployment-pod-1", type: "K8s::Core::Pod", owner: "appDeployment" },
              // Any kind can be a runtime child, not just Pods (#85/#86) —
              // e.g. a CRD's own controller-created child.
              { name: "argoApp-child", type: "ArgoCd::Application::Resource", owner: "argoApp" },
            ],
          },
        },
      },
    };
    expect(nodeDiff(withRuntime, "appDeployment-pod-1")).toEqual({
      category: "runtime",
      changes: [],
      runtimeOwner: "appDeployment",
    });
    expect(nodeDiff(withRuntime, "argoApp-child")).toEqual({
      category: "runtime",
      changes: [],
      runtimeOwner: "argoApp",
    });
    // A genuine orphan on the same lexicon is unaffected.
    expect(nodeDiff(withRuntime, "stray")).toEqual({ category: "orphan", changes: [] });
  });

  it("is backward compatible with a diff from a chant predating #1180 (no `runtimeChildren` key)", () => {
    const legacy: LiveDiffJson = {
      environment: "prod",
      lexicons: { k8s: { resources: { missing: [], orphan: ["stray"], disappeared: [], newlyObserved: [], driftedSinceSnapshot: [], unchanged: [] } } },
    };
    expect(nodeDiff(legacy, "stray")).toEqual({ category: "orphan", changes: [] });
  });
});

describe("nodeFieldDrift (#87, chant#1076/#1181)", () => {
  const withDeep: LiveDiffJson = {
    environment: "prod",
    lexicons: {
      k8s: {
        resources: { missing: [], orphan: [], disappeared: [], newlyObserved: [], driftedSinceSnapshot: [], unchanged: ["worker"] },
        deep: {
          drifted: [
            {
              name: "worker",
              type: "K8s::Apps::Deployment",
              changes: [
                { path: "metadata.labels.team", kind: "changed", declared: "platform", live: "hand-edited" },
                { path: "spec.template.spec.containers[0].image", kind: "undeclared", live: "sidecar:latest" },
              ],
            },
          ],
          accepted: [{ name: "worker", type: "K8s::Apps::Deployment", changes: [{ path: "metadata.annotations.note", kind: "changed", declared: "a", live: "b", baseline: "b" }] }],
          unchanged: ["web"],
          unobserved: [],
          undeclaredEntities: [],
        },
      },
    },
  };

  it("returns the drifted + accepted field-level changes for an entity", () => {
    expect(nodeFieldDrift(withDeep, "worker")).toEqual({
      drifted: [
        { path: "metadata.labels.team", kind: "changed", declared: "platform", live: "hand-edited" },
        { path: "spec.template.spec.containers[0].image", kind: "undeclared", live: "sidecar:latest" },
      ],
      accepted: [{ path: "metadata.annotations.note", kind: "changed", declared: "a", live: "b", baseline: "b" }],
    });
  });

  it("returns empty arrays (not null) for an entity the deep reader found nothing to report on", () => {
    expect(nodeFieldDrift(withDeep, "web")).toEqual({ drifted: [], accepted: [] });
  });

  it("returns null when no lexicon in the diff carries a `deep` section at all (#87's fallback criterion)", () => {
    const noDeep: LiveDiffJson = {
      environment: "prod",
      lexicons: { aws: { resources: { missing: [], orphan: [], disappeared: [], newlyObserved: [], driftedSinceSnapshot: [], unchanged: ["bucket"] } } },
    };
    expect(nodeFieldDrift(noDeep, "bucket")).toBeNull();
  });

  it("returns empty arrays, not null, for an entity a deep-carrying diff never mentions at all", () => {
    // Not in the deep lexicon's drifted/accepted/unchanged lists (e.g. a
    // different entity type the deep reader never touched) — still gets the
    // "deep ran, nothing here" empty-array answer, since some lexicon in the
    // diff DID carry a `deep` section (distinct from the true #87 fallback
    // case above, where NO lexicon carries one at all).
    expect(nodeFieldDrift(withDeep, "nope")).toEqual({ drifted: [], accepted: [] });
  });
});

describe("nodeObserved", () => {
  it("returns the observed live state for a managed node (#30)", () => {
    expect(nodeObserved(json, "store")).toEqual({
      type: "AWS::S3::Bucket",
      status: "CREATE_COMPLETE",
      physicalId: "my-bucket",
      attributes: { Region: "us-east-1" },
    });
  });

  it("returns null when the node has no observed record (pending) or none captured", () => {
    expect(nodeObserved(json, "gone")).toBeNull();
    expect(nodeObserved({ environment: "prod", lexicons: { aws: {} } }, "store")).toBeNull();
  });

  it("tolerates a lexicon with no resources block (artifacts-only) and empty input", () => {
    expect(nodeDiff({ environment: "prod", lexicons: { helm: { artifacts: {} } } }, "x")).toBeNull();
    expect(nodeDiff({ environment: "prod", lexicons: {} }, "x")).toBeNull();
  });
});
