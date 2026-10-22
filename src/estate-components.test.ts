import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { estateComponents, estateComponentsNote } from "./estate-components.ts";

const dag = (...ids: string[]): GraphIR => ({ nodes: ids.map((id) => ({ id, kind: "Component", lexicon: "chant", attrs: { wave: 1 } })), edges: [], groups: {} }) as unknown as GraphIR;
const entity: GraphIR = {
  nodes: [
    { id: "dns/awsRecord", kind: "AWS::Route53::RecordSet", attrs: {} },
    { id: "dns/awsEndpoint", kind: "AWS::CloudFormation::Parameter", attrs: {} },
    { id: "aws/alb", kind: "AWS::ElasticLoadBalancingV2::LoadBalancer", attrs: {} },
    { id: "app/db", kind: "AWS::RDS::DBInstance", attrs: {}, sourceLoc: { file: "data/db.ts" } },
    { id: "app/fn", kind: "AWS::Lambda::Function", attrs: {}, sourceLoc: { file: "api/fn.ts" } },
  ],
  edges: [
    { from: "dns/awsRecord", to: "dns/awsEndpoint", kind: "ref" },
    { from: "dns/awsEndpoint", to: "aws/alb", kind: "ref", viaAttr: "import" },
    { from: "app/fn", to: "aws/alb", kind: "ref" },
    { from: "app/fn", to: "app/db", kind: "ref" },
  ],
  groups: {},
} as unknown as GraphIR;

describe("estateComponents (#897)", () => {
  it("boxes each member's components and joins members through their resources", () => {
    const app = dag("data", "api");
    app.edges.push({ from: "api", to: "data", kind: "needs" } as never);
    const r = estateComponents(
      [
        { member: "dns", dag: dag("records") },
        { member: "aws", dag: dag("site") },
        { member: "app", dag: app },
        { member: "tf", dag: dag() },
        { member: "gcp", reason: "chant failed" },
      ],
      entity,
    );
    expect(r.ir.nodes.map((n) => n.id)).toEqual(["dns/records", "aws/site", "app/data", "app/api"]);
    expect(r.ir.nodes[0]!.attrs.member).toBe("dns");
    expect(r.ir.groups.byStack).toEqual({ dns: ["dns/records"], aws: ["aws/site"], app: ["app/data", "app/api"] });
    expect(r.ir.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["app/api>app/data", "dns/records>aws/site", "app/api>aws/site"]);
    expect(r.empty).toEqual(["tf"]);
    expect(r.unread).toEqual([{ member: "gcp", reason: "chant failed" }]);
  });

  it("says what the picture leaves out", () => {
    expect(estateComponentsNote({ empty: [], unread: [] }, 0)).toBe("no member declares a component (a `*.component.ts` file)");
    expect(estateComponentsNote({ empty: ["tf"], unread: [{ member: "gcp", reason: "x" }] }, 3)).toBe("no components declared in tf · gcp's components couldn't be read: x");
    expect(estateComponentsNote({ empty: [], unread: [] }, 3)).toBeUndefined();
  });
});
