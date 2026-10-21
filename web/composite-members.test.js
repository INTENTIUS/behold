import { describe, expect, it } from "vitest";
import { indexCompositeMembers } from "./composite-members.js";

const nodes = [
  { id: "webCluster", kind: "AWS::ECS::Cluster", compositeInstance: "web", compositeParent: "FargateAlb" },
  { id: "webService", kind: "AWS::ECS::Service", compositeInstance: "web", compositeParent: "FargateAlb" },
  { id: "GcpwebService", kind: "RunService", compositeInstance: "web", compositeParent: "CloudRunServiceComposite" },
  { id: "zone", kind: "AWS::Route53::HostedZone" },
];

describe("indexCompositeMembers (#828)", () => {
  it("lists each of two same-named composites under chant's split id", () => {
    const idx = indexCompositeMembers(nodes);
    expect(idx["web@FargateAlb"].map((m) => m.id)).toEqual(["webCluster", "webService"]);
    expect(idx["web@CloudRunServiceComposite"]).toEqual([{ id: "GcpwebService", kind: "RunService" }]);
  });
  it("keeps the bare instance id for a composite whose name is its own", () => {
    const idx = indexCompositeMembers([{ id: "a", kind: "K", compositeInstance: "app", compositeParent: "Thing" }]);
    expect(idx.app).toEqual([{ id: "a", kind: "K" }]);
  });
  it("leaves out nodes no composite owns", () => {
    expect(Object.values(indexCompositeMembers(nodes)).flat().some((m) => m.id === "zone")).toBe(false);
    expect(indexCompositeMembers(undefined)).toEqual({});
  });
});
