import { afterAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";

// behold#1080: /api/graph on a served workspace whose chant is at the
// reference catalog's floor. The members' graphs and the workspace read are
// the recorded documents (e2e/fixtures/reference-catalog); nothing spawns.
const FIXTURES = join(import.meta.dirname, "..", "e2e", "fixtures", "reference-catalog");
const doc = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, `${name}.graph.json`), "utf8"));

let current = "three-kinds";

vi.mock("./estate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./estate.ts")>();
  return {
    ...actual,
    // The composed estate of the recorded document: its nodes, boxed by member.
    composeEstate: vi.fn(async () => {
      const d = doc(current);
      const nodes = (d.nodes as Array<{ id: string; member: string }>).map(({ member: _m, ...n }) => n);
      const byStack: Record<string, string[]> = {};
      for (const n of d.nodes as Array<{ id: string; member: string }>) (byStack[n.member] ??= []).push(n.id);
      return { version: 1, nodes, edges: [], groups: { byStack, byLexicon: {}, byComposite: {} }, exports: [], imports: [] } as unknown as GraphIR;
    }),
  };
});
vi.mock("./reference-catalog.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reference-catalog.ts")>();
  return {
    ...actual,
    readReferenceCatalog: vi.fn(async (_root: string, opts: { chant?: string }) =>
      actual.readReferenceCatalog("/work/estate", opts, { read: async () => doc(current) as never }),
    ),
  };
});

import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { setServedWorkspace, type Workspace } from "./workspace.ts";

function workspace(chant: string, members: string[]): Workspace {
  return {
    name: "estate",
    root: "/work/estate",
    file: "chant.workspace.json",
    chant,
    members: members.map((name) => ({ name, dir: name, kind: "chant", abs: `/work/estate/${name}`, reason: null, because: null })) as Workspace["members"],
  };
}

function appFor(chant: string, members: string[]) {
  const broadcaster = new Broadcaster();
  const runner = new OpRunner({ projectDir: "/work/estate", broadcaster, onDone: () => {} });
  return createApp({ projectDir: `/work/estate/${members[0]}`, projectDirs: members.map((m) => `/work/estate/${m}`), port: 0, workspace: workspace(chant, members) }, broadcaster, new FrameBuffer(), runner);
}

afterAll(() => setServedWorkspace(undefined));

type Body = { ir: GraphIR & { catalog?: unknown }; svg: string; meta: { note?: string; catalogLegend?: Array<{ weight: string; count: number }> } };
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

describe("GET /api/graph over the reference catalog (behold#1080)", () => {
  it("draws one joined edge, one placeholder card and two dotted edges, each with a legend row", async () => {
    current = "three-kinds";
    const res = await appFor("0.124.98", ["app", "a", "b"]).request("/api/graph?alike=0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(count(body.svg, /data-edge-weight="joined"/g)).toBe(2);
    expect(count(body.svg, /data-node-dangling="true"/g)).toBe(1);
    expect(count(body.svg, /<g data-edge-from="[^"]*" data-edge-to="[^"]*"[^>]*data-edge-weight="ambiguous"[^>]*><title>/g)).toBe(2);
    expect(body.meta.catalogLegend?.map((r) => r.weight)).toEqual(["joined", "dangling", "ambiguous"]);
    expect(count(body.svg, /data-legend-row=/g)).toBe(3);
    // The references with no rule of drawing are still counted in the note.
    expect(body.meta.note).toContain("3 references to targets not declared here");
  });

  it("draws what it always drew on a chant below the floor", async () => {
    current = "three-kinds";
    const res = await appFor("0.124.97", ["app", "a", "b"]).request("/api/graph?alike=0");
    const body = (await res.json()) as Body;
    expect(body.ir.catalog).toBeUndefined();
    expect(body.svg).not.toContain("data-edge-weight");
    expect(body.svg).not.toContain("data-node-dangling");
    expect(body.meta.catalogLegend).toBeUndefined();
  });

  it("anchors the Kubernetes nodes to prod only, from chant's cluster join", async () => {
    current = "cluster-two-declared";
    const body = (await (await appFor("0.124.98", ["argo", "tf"]).request("/api/graph?alike=0")).json()) as Body;
    const anchors = body.ir.edges.filter((e) => (e as { viaAttr?: string }).viaAttr === "runs-on").map((e) => `${e.from} > ${e.to}`);
    expect(anchors).toEqual(["tf/tf/google_container_cluster.prod > argo/argo/applicationWeb"]);
  });

  it("draws no anchor and says why when the Terraform cluster was renamed", async () => {
    current = "cluster-renamed";
    const body = (await (await appFor("0.124.98", ["argo", "tf"]).request("/api/graph?alike=0")).json()) as Body;
    expect(body.ir.edges.filter((e) => (e as { viaAttr?: string }).viaAttr === "runs-on")).toEqual([]);
    expect(body.meta.note).toContain('registers cluster "prod", which no cluster resource names');
    expect(body.meta.note).toContain("its objects are anchored to no cluster");
    expect(count(body.svg, /data-node-dangling="true"/g)).toBe(1);
  });
});
