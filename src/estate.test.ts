import { describe, it, expect, vi } from "vitest";

// composeEstate graphs each project via chant.ts; mock that to test the wiring
// (naming + composition) without shelling chant.
vi.mock("./chant.ts", () => ({ graphIr: vi.fn() }));
import { graphIr } from "./chant.ts";
import { composeEstate, composeEstateOverlay } from "./estate.ts";
import { attachRuntimeContainment } from "./overlay.ts";
import type { GraphIR as ChantGraphIR } from "@intentius/chant";

const stack = (nodeId: string, lexicon = "aws") => ({
  nodes: [{ id: nodeId, kind: "X", lexicon, attrs: {} }],
  edges: [],
  groups: {},
});

describe("composeEstate (#31)", () => {
  it("graphs each project and composes into one estate with per-project byStack groups", async () => {
    vi.mocked(graphIr)
      .mockResolvedValueOnce(stack("vpc") as never)
      .mockResolvedValueOnce(stack("svc") as never);

    const ir = await composeEstate(["/work/infra", "/work/api"]);

    expect(graphIr).toHaveBeenCalledTimes(2);
    // Nodes are namespaced per stack; byStack groups them by the short project name.
    expect(Object.keys(ir.groups.byStack ?? {}).sort()).toEqual(["api", "infra"]);
    expect(ir.nodes.map((n) => n.id).sort()).toEqual(["api/svc", "infra/vpc"]);
  });
});

// #224: composeStacks namespaces node ids but not chant's `runtimeOwner`, so
// a composed estate's runtime children used to name an owner id that no node
// in the composed IR carries — attachRuntimeContainment then drew a box with
// the children in it and the owner outside (the #144 shape).
describe("composeEstateOverlay — runtime owners survive composition (#224)", () => {
  const owned = (owner: string) => ({
    nodes: [
      { id: "kustomization", kind: "K8s::Flux::Kustomization", lexicon: "k8s", attrs: { _status: "good" } },
      { id: "pod", kind: "K8s::Core::Pod", lexicon: "k8s", attrs: { _status: "runtime" }, runtimeOwner: owner },
    ],
    edges: [],
    groups: {},
  });

  it("re-points each runtime child at its owner's composed id, so the containment box holds both", async () => {
    // A fresh IR per call — chant hands each project its own graph, and the
    // remap mutates what it is given.
    vi.mocked(graphIr).mockImplementation(async () => owned("kustomization") as never);

    const est = await composeEstateOverlay(["/work/control-plane", "/work/app-a"], { env: "local" }, (ir) => ir);
    const child = est.ir.nodes.find((n) => n.id === "control-plane/pod")!;
    expect((child as { runtimeOwner?: string }).runtimeOwner).toBe("control-plane/kustomization");

    // `est.ir` is pinhole's GraphIR; chant's is the same IR with the index
    // signature on `groups` the containment pass reads through (see server.ts).
    const boxed = attachRuntimeContainment(est.ir as ChantGraphIR);
    // Owner AND child inside the box keyed by the owner's composed id (#144).
    expect(boxed.groups.byContainer?.["control-plane/kustomization"]).toEqual([
      "control-plane/kustomization",
      "control-plane/pod",
    ]);
  });

  it("leaves an owner name no node in that project carries alone — a rewrite would only move the lie", async () => {
    vi.mocked(graphIr).mockImplementation(async () => owned("someone-else") as never);
    const est = await composeEstateOverlay(["/work/control-plane"], { env: "local" }, (ir) => ir);
    const child = est.ir.nodes.find((n) => n.id.endsWith("/pod"))!;
    expect((child as { runtimeOwner?: string }).runtimeOwner).toBe("someone-else");
  });
});
