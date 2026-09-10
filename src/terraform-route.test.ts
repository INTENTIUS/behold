import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";

// The routes read a Terraform estate that DECLARES the lexicon the way they
// read any chant project — one `chant graph` shell-out — so the seam to mock is
// the same one estate.test.ts mocks. Everything else stays real: the three
// passes, the lens, the note. The bare directory #384 serves takes the member
// kind's own read instead, and the block at the bottom of this file covers it.
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
import { registerMemberKind } from "./member-kind.ts";
import { TerraformReadError, hasTerraformRoots } from "./terraform-member.ts";

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

// ---------------------------------------------------------------------------
// #384 — the same routes over a directory of `.tf` files and nothing else.
// The kind is registered with its REAL probe, so this is the dispatch a bare
// Terraform directory actually takes; only the read (where the lexicon and the
// generated config would be) is stubbed, and the roots note comes from the real
// walk over the estate on disk.
// ---------------------------------------------------------------------------
describe("GET /api/graph over a bare Terraform directory (#384)", () => {
  const made: string[] = [];
  afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

  /** water park's shapes in miniature: two roots, a called module, a backend
   * fragment. See src/terraform-member.test.ts for the provenance. */
  function estate(): string {
    const root = mkdtempSync(join(tmpdir(), "behold-tf-route-"));
    made.push(root);
    const write = (rel: string, content: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    };
    const versions = "terraform {\n  required_providers {\n    aws = {}\n  }\n}\n";
    write("envs/prod/versions.tf", versions);
    write("envs/prod/main.tf", 'resource "aws_s3_bucket" "artifacts" {}\n');
    write("baseline/versions.tf", versions);
    write("baseline/main.tf", 'resource "aws_iam_policy" "boundary" {}\n');
    write("modules/persona/versions.tf", versions);
    write("modules/persona/main.tf", 'resource "aws_iam_role" "this" {}\n');
    write("backends/backend.local.tf", 'terraform {\n  backend "local" {}\n}\n');
    return root;
  }

  const serve = (dir: string) => {
    const broadcaster = new Broadcaster();
    return createApp({ projectDir: dir, port: 0 }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
  };

  it("serves it, and the note says which roots it found and what it skipped", async () => {
    const dir = estate();
    const read = vi.fn(async (_dir: string) => fixture());
    registerMemberKind({ kind: "terraform", probe: hasTerraformRoots, expects: "a Terraform root", via: { tool: () => "lexicon\0v1", read: read as never } });

    const { ir, meta } = (await (await serve(dir).request("/api/graph?detail=2")).json()) as { ir: GraphIR; meta: { note?: string } };

    // Read by the kind, never by chant.
    expect(read.mock.calls.map(([d]) => d)).toEqual([dir]);
    expect(graphIr).not.toHaveBeenCalled();
    // The #379/#380/#382 passes still ran: boxed by root, titled by resource type.
    expect(Object.keys(ir.groups.byStack ?? {}).sort()).toEqual(["baseline", "runner"]);
    expect(meta.note).toBe(
      "2 roots — baseline, prod; skipped backends (no resource, data or module block — nothing to draw), modules/persona (called as a module, never applied on its own); " +
        "showing the estate — 11 variables, 9 outputs, 3 terraform blocks, 2 locals blocks, 1 provider not drawn (outputs and variables appear at detail 3 — ⌘K → attributes)",
    );
  });

  // -------------------------------------------------------------------------
  // #393 — what the audit found on the water park estate, at the routes.
  // -------------------------------------------------------------------------
  it("carries the roots note through the logical zoom, and a short form for the strip (items 5, 7)", async () => {
    const dir = estate();
    registerMemberKind({ kind: "terraform", probe: hasTerraformRoots, expects: "a Terraform root", via: { tool: () => "lexicon\0v1", read: (async () => fixture()) as never } });

    const app = serve(dir);
    const resources = (await (await app.request("/api/graph?detail=2")).json()) as { meta: { note?: string; noteShort?: string } };
    const logical = (await (await app.request("/api/graph?logical=1")).json()) as { meta: { note?: string; noteShort?: string } };

    // The one line that explains the picture does not vanish with the lens.
    expect(logical.meta.note).toContain("2 roots — baseline, prod");
    expect(logical.meta.note).toContain("skipped backends");
    // And both zooms hand the 260px strip something that fits, with the counts
    // the long sentence spells out.
    expect(resources.meta.noteShort).toBe("2 roots · 2 skipped · 26 blocks not drawn");
    expect(logical.meta.noteShort).toBe(resources.meta.noteShort);
  });

  it("says what its members are, and never offers the runtime zoom (items 1, 2)", async () => {
    const dir = estate();
    registerMemberKind({ kind: "terraform", probe: hasTerraformRoots, expects: "a Terraform root", via: { tool: () => "lexicon\0v1", read: (async () => fixture()) as never } });

    const info = (await (await serve(dir).request("/api/project")).json()) as { memberKinds: string[]; runtimeCapable?: boolean };

    // The SPA boots on `resources` off this: no chant member, no components.
    expect(info.memberKinds).toEqual(["terraform"]);
    // A Terraform root has no owner-reference chain, so there is no tier below
    // the declaration boundary to descend to.
    expect(info.runtimeCapable).toBeUndefined();
  });

  it("answers /api/resources with the empty facet instead of 500ing (item 3)", async () => {
    const dir = estate();
    registerMemberKind({ kind: "terraform", probe: hasTerraformRoots, expects: "a Terraform root", via: { tool: () => "lexicon\0v1", read: (async () => fixture()) as never } });

    const res = await serve(dir).request("/api/resources");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ byComponent: {} });
    // Nothing was asked of chant: there is no chant here to ask.
    expect(graphIr).not.toHaveBeenCalled();
  });

  it("draws no empty member box for the directory it composed (item 6)", async () => {
    const dir = estate();
    registerMemberKind({ kind: "terraform", probe: hasTerraformRoots, expects: "a Terraform root", via: { tool: () => "lexicon\0v1", read: (async () => fixture()) as never } });

    // How `behold serve <a terraform directory>` actually arrives (#389): the
    // lone directory is composed as a one-member estate, so `composeStacks`
    // puts a box named after it around every node — and the root boxes then
    // take those same nodes.
    const broadcaster = new Broadcaster();
    const app = createApp({ projectDir: dir, projectDirs: [dir], port: 0 }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
    const { ir } = (await (await app.request("/api/graph?detail=2")).json()) as { ir: GraphIR };

    const boxes = ir.groups.byStack as Record<string, string[]>;
    expect(Object.values(boxes).every((ids) => ids.length > 0)).toBe(true);
    expect(Object.keys(boxes).sort()).toEqual(["baseline", "runner"]);
  });

  it("still says the components lens does not apply when someone picks it (item 1)", async () => {
    const dir = estate();
    registerMemberKind({ kind: "terraform", probe: hasTerraformRoots, expects: "a Terraform root", via: { tool: () => "lexicon\0v1", read: (async () => fixture()) as never } });

    const broadcaster = new Broadcaster();
    const app = createApp({ projectDir: dir, projectDirs: [dir], port: 0 }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
    const { meta } = (await (await app.request("/api/graph?components=1")).json()) as { meta: { note?: string } };

    // The SPA no longer BOOTS here (item 1), but the stop is still pickable and
    // the picker must not look applied: the reason comes first, and the
    // estate's own note follows it rather than replacing it.
    expect(meta.note).toMatch(/^the components lens doesn't apply to a composed estate yet/);
    expect(meta.note).toContain("2 roots — baseline, prod");
  });

  it("answers the reader's own refusal, with the install line, when the lexicon is not there", async () => {
    const dir = estate();
    const refusal = {
      error: "Reading a Terraform estate needs chant's terraform lexicon, which behold does not install: …",
      code: "terraform-lexicon" as const,
      remedy: "Install @intentius/chant-lexicon-terraform@^0.61.0 @cdktf/hcl2json@^0.21.0 beside behold, then reload.",
    };
    registerMemberKind({
      kind: "terraform",
      probe: hasTerraformRoots,
      expects: "a Terraform root",
      via: {
        tool: () => "lexicon\0absent",
        read: (async () => {
          throw new TerraformReadError(refusal, dir);
        }) as never,
      },
    });

    const res = await serve(dir).request("/api/graph?detail=2");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(refusal);
  });
});
