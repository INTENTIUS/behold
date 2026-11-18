// behold#1191: a source's scope key in plain words.
import { describe, expect, it } from "vitest";
import { sourceLabel } from "./source-label.js";

describe("sourceLabel", () => {
  it("names each source the way a person would", () => {
    expect(sourceLabel("chant/aws")).toBe("the aws member");
    expect(sourceLabel("chant/.")).toBe("the project");
    expect(sourceLabel("engine/choudoufu/three-cloud-azure@azure")).toBe("the azure member's choudoufu graph");
    expect(sourceLabel("engine/plunge/app/dev")).toBe("plunge's graph of app/dev");
    expect(sourceLabel("cloud/aws/000000000000/db1d7f66ad8c")).toBe("the AWS account's index");
    expect(sourceLabel("cloud/aws/123456789012/17c896e234d7")).toBe("the real AWS account's index");
    expect(sourceLabel("cloud/gcp/demo-project/0123")).toBe("the GCP project's index");
    expect(sourceLabel("cloud/kubernetes/kind-behold-ask-demo/eb3c475548a6")).toBe("the kind cluster's index");
    expect(sourceLabel("cloud/kubernetes/prod-eu/eb3c475548a6")).toBe("the cluster's index");
    expect(sourceLabel("cloud/oci/tenancy/abc")).toBe("the oci index");
  });
  it("returns a key of another shape as it is", () => {
    for (const k of ["somewhere/else", "chant", "cloud/aws/000000000000", "engine/choudoufu"]) expect(sourceLabel(k)).toBe(k);
    expect(sourceLabel(undefined)).toBe("");
  });
});
