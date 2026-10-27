import { describe, it, expect } from "vitest";
import { stringLeaves } from "./attr-leaves.ts";

describe("stringLeaves (#166)", () => {
  it("walks objects and arrays to their string leaves, eliding array indices", () => {
    const leaves = stringLeaves({ spec: { containers: [{ env: [{ name: "A", value: "one" }, { name: "B", value: "two" }] }] } });
    expect(leaves).toEqual([
      { path: "spec.containers.env.name", key: "name", value: "A" },
      { path: "spec.containers.env.value", key: "value", value: "one" },
      { path: "spec.containers.env.name", key: "name", value: "B" },
      { path: "spec.containers.env.value", key: "value", value: "two" },
    ]);
  });

  it("does not enter observed state, rendered blobs, the selector lexicon, or behold's own paint", () => {
    const leaves = stringLeaves({
      status: { phase: "Running-and-observed" },
      metadata: {
        name: "keep-this-one",
        labels: { app: "shopfront-web" },
        annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{…the whole object…}" },
        managedFields: [{ manager: "kubectl-client-side-apply" }],
      },
      _status: "neutral",
    });
    expect(leaves).toEqual([{ path: "metadata.name", key: "name", value: "keep-this-one" }]);
  });

  it("terminates on a cycle, and keeps a shared sibling object", () => {
    const shared = { ref: "shared-value-here" };
    const cyclic: Record<string, unknown> = { spec: { shared, also: shared } };
    (cyclic.spec as Record<string, unknown>).self = cyclic;
    expect(stringLeaves(cyclic).map((l) => l.value)).toEqual(["shared-value-here", "shared-value-here"]);
  });
});
