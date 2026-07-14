import { describe, it, expect, vi } from "vitest";

// composeEstate graphs each project via chant.ts; mock that to test the wiring
// (naming + composition) without shelling chant.
vi.mock("./chant.ts", () => ({ graphIr: vi.fn() }));
import { graphIr } from "./chant.ts";
import { composeEstate } from "./estate.ts";

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
