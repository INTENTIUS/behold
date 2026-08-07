import { describe, test, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { projectFlyLogical, appBoxTitle } from "./logical-fly.ts";
import { projectTopology } from "./logical.ts";

const fly = (id: string, kind: string, attrs: Record<string, unknown> = {}) =>
  ({ id, kind, lexicon: "fly", attrs, sourceLoc: { file: "infra.ts" } }) as never;

const irOf = (nodes: unknown[], edges: unknown[] = []): GraphIR =>
  ({ nodes: nodes as never, edges: edges as never, groups: {} });

describe("projectFlyLogical (behold#167)", () => {
  test("no fly nodes: empty projection", () => {
    const ir = irOf([{ id: "svc", kind: "K8s::Core::Service", lexicon: "k8s", attrs: {} }]);
    const p = projectFlyLogical(ir);
    expect(p.ir.nodes).toHaveLength(0);
    expect(p.byContainer).toEqual({});
  });

  test("sole app owns everything — machines, volumes, IPs join its box", () => {
    const ir = irOf([
      fly("app", "Fly::Machines::App", { name: "my-app" }),
      fly("web", "Fly::Machines::Machine", { name: "web", region: { $intrinsic: true } }),
      fly("data", "Fly::Machines::Volume", { name: "data" }),
      fly("v4", "Fly::Machines::IPAddress", { type: "v4" }),
    ]);
    const p = projectFlyLogical(ir);
    expect(p.byContainer[appBoxTitle("my-app")]).toEqual(["app", "web", "data", "v4"]);
    expect(p.ir.nodes.map((n) => n.id)).toEqual(["app", "web", "data", "v4"]);
  });

  test("an unnamed app boxes by node id — an unnamed box beats a dropped app", () => {
    const ir = irOf([fly("app", "Fly::Machines::App"), fly("web", "Fly::Machines::Machine")]);
    const p = projectFlyLogical(ir);
    expect(p.byContainer[appBoxTitle("app")]).toEqual(["app", "web"]);
  });

  test("two apps, no refs: cards stay at the root rather than being guessed in", () => {
    const ir = irOf([
      fly("a", "Fly::Machines::App", { name: "front" }),
      fly("b", "Fly::Machines::App", { name: "back" }),
      fly("web", "Fly::Machines::Machine", { name: "web" }),
    ]);
    const p = projectFlyLogical(ir);
    expect(p.byContainer[appBoxTitle("front")]).toEqual(["a"]);
    expect(p.byContainer[appBoxTitle("back")]).toEqual(["b"]);
    const boxed = Object.values(p.byContainer).flat();
    expect(boxed).not.toContain("web");
    expect(p.ir.nodes.map((n) => n.id)).toContain("web"); // still a card
  });

  test("a declared $ref to an app wins even among several apps", () => {
    const ir = irOf([
      fly("a", "Fly::Machines::App", { name: "front" }),
      fly("b", "Fly::Machines::App", { name: "back" }),
      fly("web", "Fly::Machines::Machine", { config: { env: { APP: { $ref: "b.name" } } } }),
    ]);
    const p = projectFlyLogical(ir);
    expect(p.byContainer[appBoxTitle("back")]).toEqual(["b", "web"]);
    expect(p.byContainer[appBoxTitle("front")]).toEqual(["a"]);
  });

  test("self-refs to deploy-time readonly attrs do not create membership or edges", () => {
    // chant emits `{$ref:"web.checks"}` on `web` itself for readonly attrs.
    const ir = irOf([
      fly("app", "Fly::Machines::App", { name: "my-app", status: { $ref: "app.status" } }),
      fly("web", "Fly::Machines::Machine", { checks: { $ref: "web.checks" } }),
    ]);
    const p = projectFlyLogical(ir);
    expect(p.byContainer[appBoxTitle("my-app")]).toEqual(["app", "web"]);
    expect(p.ir.edges).toHaveLength(0);
  });

  test("a machine mount referencing its volume draws an edge; app refs stay containment", () => {
    const ir = irOf([
      fly("app", "Fly::Machines::App", { name: "my-app" }),
      fly("web", "Fly::Machines::Machine", {
        config: { mounts: [{ volume: { $ref: "data.id" } }], env: { APP: { $ref: "app.name" } } },
      }),
      fly("data", "Fly::Machines::Volume", { name: "data" }),
    ]);
    const p = projectFlyLogical(ir);
    expect(p.ir.edges).toEqual([{ from: "web", to: "data", kind: "ref" }]);
  });

  test("secrets are plumbing — dropped from the picture, never a card", () => {
    const ir = irOf([
      fly("app", "Fly::Machines::App", { name: "my-app" }),
      fly("token", "Fly::Machines::Secret", { name: "token" }),
    ]);
    const p = projectFlyLogical(ir);
    expect(p.ir.nodes.map((n) => n.id)).toEqual(["app"]);
    expect(Object.values(p.byContainer).flat()).not.toContain("token");
  });
});

describe("projectTopology — fly dispatch (behold#167)", () => {
  test("a fly-only graph projects through the fly lens", () => {
    const ir = irOf([
      fly("app", "Fly::Machines::App", { name: "my-app" }),
      fly("web", "Fly::Machines::Machine", { name: "web" }),
    ]);
    const { ir: out, byContainer } = projectTopology(ir, "prod");
    expect(out.nodes.map((n) => n.id)).toEqual(["app", "web"]);
    expect(byContainer[appBoxTitle("my-app")]).toEqual(["app", "web"]);
  });

  test("a mixed fly + k8s estate keeps both halves", () => {
    const ir = irOf([
      fly("app", "Fly::Machines::App", { name: "my-app" }),
      { id: "svc", kind: "K8s::Core::Service", lexicon: "k8s", attrs: { metadata: { namespace: "web" } } },
    ]);
    const { ir: out, byContainer } = projectTopology(ir, "prod");
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["app", "svc"]);
    expect(byContainer[appBoxTitle("my-app")]).toEqual(["app"]);
    expect(byContainer["namespace web"]).toContain("svc");
  });
});
