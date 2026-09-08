import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";

// The routes read a Terraform estate the way they read any chant project — one
// `chant graph` shell-out — so the seam to mock is the same one estate.test.ts
// mocks. Everything else stays real: the three passes, the lens, the note.
vi.mock("./chant.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chant.ts")>()),
  graphIr: vi.fn(),
}));
import { graphIr } from "./chant.ts";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { resetMemberIrCache } from "./member-ir.ts";

// Provenance: `chant graph --format ir --detail 3` over water park's
// `access/baseline` and its `waterpark-runner` satellite as two roots, through
// `@intentius/chant-lexicon-terraform` 0.59.0. See terraform-lens.test.ts.
const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (): GraphIR => JSON.parse(readFileSync(join(HERE, "__fixtures__", "terraform-ir-two-roots.json"), "utf8")) as GraphIR;

function served() {
  const broadcaster = new Broadcaster();
  const dir = "/work/tf-estate";
  return createApp({ projectDir: dir, port: 0 }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
}

const graph = async (query = ""): Promise<{ ir: GraphIR; svg: string; byContainer?: Record<string, string[]>; meta: { note?: string } }> =>
  (await (await served().request(`/api/graph${query}`)).json()) as never;

beforeEach(() => {
  resetMemberIrCache();
  vi.mocked(graphIr).mockReset();
  // A fresh copy per call: the passes mutate what they are handed.
  vi.mocked(graphIr).mockImplementation((async () => fixture()) as never);
});

describe("GET /api/graph over a Terraform estate (#379/#380/#382)", () => {
  it("draws the estate, boxed by root, titled by resource type", async () => {
    const { ir, svg, meta } = await graph("?detail=2");
    expect(ir.nodes).toHaveLength(4);
    expect(Object.fromEntries(Object.entries(ir.groups.byStack ?? {}).map(([k, v]) => [k, v.length]))).toEqual({ baseline: 1, runner: 3 });
    expect(ir.nodes.map((n) => n.kind).sort()).toEqual(["aws_ecr_repository", "aws_iam_policy", "aws_iam_policy", "module"]);
    expect(ir.nodes.some((n) => n.kind.startsWith("Terraform::"))).toBe(false);
    expect(meta.note).toBe(
      "showing the estate — 11 variables, 9 outputs, 3 terraform blocks, 2 locals blocks, 1 provider not drawn (outputs and variables appear at detail 3 — ⌘K → attributes)",
    );
    // It really rendered: the card is in the SVG under its own address.
    expect(svg).toContain("baseline/aws_iam_policy.boundary");
  });

  it("adds the interface at detail 3, and still never the settings", async () => {
    const { ir, meta } = await graph("?detail=3");
    expect(ir.nodes).toHaveLength(24);
    expect(meta.note).toBe("showing the estate — 3 terraform blocks, 2 locals blocks, 1 provider not drawn");
    const data = ir.nodes.find((n) => n.id === "runner/data.aws_iam_policy.boundary")!;
    // #381: the read is a row with the interpolation unresolved, never an edge.
    expect(data.attrs.reads).toBe("name ${var.boundary_name}");
    expect(ir.edges).toEqual([]);
  });

  it("the logical lens boxes the same cards by root", async () => {
    const { ir, byContainer } = await graph("?logical=1");
    expect(byContainer).toEqual({ "root baseline": ["baseline/aws_iam_policy.boundary"], "root runner": expect.arrayContaining(["runner/aws_ecr_repository.waterpark_runner"]) });
    expect(ir.nodes).toHaveLength(4);
  });

  it("says nothing about Terraform for an estate that has none", async () => {
    const plain: GraphIR = {
      nodes: [{ id: "web", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: { metadata: { name: "web" } } }],
      edges: [],
      groups: { byStack: { app: ["web"] } },
    };
    vi.mocked(graphIr).mockImplementation((async () => JSON.parse(JSON.stringify(plain)) as GraphIR) as never);
    const { ir, meta } = await graph("?detail=2");
    expect(ir.nodes.map((n) => n.kind)).toEqual(["K8s::Apps::Deployment"]);
    expect(meta.note ?? "").not.toContain("showing the estate");
  });
});
