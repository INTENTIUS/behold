// behold#926: a capability answer draws its path, and behold passes chant's
// capability catalog through, as `GET /api/capabilities` and behold mcp's
// `capabilities` tool. The first half holds the shapes with stand-ins; the
// second runs the real chant over the Terraform form of chant's ledger
// fixture (src/__fixtures__/capabilities-ledger, copied from chant's
// lexicons/terraform/src/__fixtures__/capabilities/ledger, chant#4375), gated
// on the chant that prints the capabilities document.
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CAPABILITIES_CHANT_FLOOR, CHANT_FLOORS, floorFor } from "./chant-floors.ts";
import { meetsFloor } from "./floor.ts";
import { drawnOf, runCapabilities } from "./search.ts";
import { capabilitiesArgv, workspaceReader, type TransportRun, type WorkspaceReader } from "./workspace-reader.ts";
import { createApp } from "./server.ts";
import { callTool, locateServe, TOOLS, type Context, type Fetch } from "./mcp.ts";
import { localCapabilities, localServeOptions } from "./shot-cli.ts";
import { realDir } from "./serve-registry.ts";
import { discoverTerraformRoots, HCL_PARSER_PKG, resolvedVersion, TERRAFORM_LEXICON_PKG, writeTerraformScratchProject } from "./terraform-member.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const HEAD = { $schema: "https://intentius.io/chant/schemas/workspace/search/v1/search.schema.json", contract: 1, chant: "0.124.46", at: null };

/**
 * `cap:internet-reachable(22)` on the ledger, as chant prints it (ids bare):
 * the bastion's route to the internet gateway is in `because`, not in the
 * path's own `hops`, and one hop ends inside the security group.
 */
const CAP_MATCH = {
  id: "aws_instance.web",
  displayId: "aws_instance.web",
  kind: "Terraform::Resource",
  paths: [
    {
      term: "cap:internet-reachable(22)",
      dir: "out",
      hops: [],
      because: [
        {
          capability: "internet-facing",
          id: "aws_instance.web",
          hops: [
            { from: "aws_instance.web", fromAttr: "subnet_id", to: "aws_subnet.public", toAttr: "id", edge: "subnet" },
            { from: "aws_route_table_association.public", fromAttr: "subnet_id", to: "aws_subnet.public", toAttr: "id", edge: "subnet" },
            { from: "aws_route_table_association.public", fromAttr: "route_table_id", to: "aws_route_table.public", toAttr: "id", edge: "table" },
            { from: "aws_route.public_default", fromAttr: "route_table_id", to: "aws_route_table.public", toAttr: "id", edge: "table" },
            { from: "aws_route.public_default", fromAttr: "gateway_id", to: "aws_internet_gateway.igw", toAttr: "id", edge: "gateway" },
          ],
        },
        {
          capability: "open-ingress",
          id: "aws_instance.web",
          hops: [
            { from: "aws_instance.web", fromAttr: "launch_template", to: "aws_launch_template.web", toAttr: "id", edge: "template" },
            { from: "aws_launch_template.web", fromAttr: "vpc_security_group_ids", to: "aws_security_group.web", toAttr: "id", edge: "sg" },
            { from: "aws_security_group.web", fromAttr: "ingress", to: "aws_security_group.web#ingress[1]", edge: "ingress" },
          ],
        },
        { capability: "world-open", id: "aws_security_group.web#ingress[1]", hops: [] },
      ],
    },
  ],
};

describe("drawnOf: a capability match's path is drawn from its because hops (chant#4375)", () => {
  it("lights the route to the internet gateway, and every hop on it", () => {
    const d = drawnOf({ ...HEAD, query: "cap:internet-reachable(22)", matches: [CAP_MATCH] });
    expect(d.lit).toEqual(["aws_instance.web"]);
    expect(d.onPath).toContain("aws_internet_gateway.igw");
    expect(d.onPath.sort()).toEqual(
      ["aws_internet_gateway.igw", "aws_launch_template.web", "aws_route.public_default", "aws_route_table.public", "aws_route_table_association.public", "aws_security_group.web", "aws_subnet.public"].sort(),
    );
    // Each hop keeps its own direction; the one into the security group's ingress rule ends on the group's own card, so it draws no edge.
    expect(d.edges.map((h) => `${h.from} -> ${h.to}`)).toEqual([
      "aws_instance.web -> aws_subnet.public",
      "aws_route_table_association.public -> aws_subnet.public",
      "aws_route_table_association.public -> aws_route_table.public",
      "aws_route.public_default -> aws_route_table.public",
      "aws_route.public_default -> aws_internet_gateway.igw",
      "aws_instance.web -> aws_launch_template.web",
      "aws_launch_template.web -> aws_security_group.web",
    ]);
    expect(d.edges[0]).toEqual({ from: "aws_instance.web", fromAttr: "subnet_id", to: "aws_subnet.public", toAttr: "id" });
  });

  it("reads a because nested in a because entry, at any depth, and the path's own hops too", () => {
    const d = drawnOf({
      ...HEAD,
      query: "cap:x",
      matches: [
        {
          id: "a",
          displayId: "a",
          kind: "K",
          paths: [
            {
              term: "cap:x",
              dir: "out",
              hops: [{ from: "a", to: "b" }],
              because: [{ capability: "y", id: "b", hops: [{ from: "b", to: "c" }], because: [{ capability: "z", id: "c", hops: [{ from: "c", to: "d#stmt[0]" }], because: [{ capability: "w", id: "d", hops: [{ from: "e", to: "d" }] }] }] }],
            },
          ],
        },
      ],
    });
    expect(d.edges.map((h) => `${h.from} -> ${h.to}`)).toEqual(["a -> b", "b -> c", "c -> d", "e -> d"]);
    expect(d.onPath.sort()).toEqual(["b", "c", "d", "e"]);
  });
});

describe("the catalog read: one chant call through the reader, behind the floor", () => {
  const CATALOG = { $schema: "https://intentius.io/chant/schemas/workspace/capabilities/v1/capabilities.schema.json", contract: 1, chant: "0.124.46", capabilities: [{ name: "internet-facing" }], helpers: [] };
  const recording = (doc: Record<string, unknown>): { reader: (root: string) => WorkspaceReader; calls: Array<{ argv: string[]; root: string }> } => {
    const calls: Array<{ argv: string[]; root: string }> = [];
    return {
      reader: (root) =>
        workspaceReader({
          run: async (argv): Promise<TransportRun> => {
            calls.push({ argv, root });
            return { status: 0, stdout: JSON.stringify(doc), stderr: "" };
          },
        }),
      calls,
    };
  };

  it("asks chant workspace search --capabilities at a workspace root, plain chant search --capabilities elsewhere", async () => {
    expect(capabilitiesArgv("workspace")).toEqual(["workspace", "search", "--capabilities", "--json"]);
    expect(capabilitiesArgv("project")).toEqual(["search", "--capabilities", "--json"]);
    const w = recording(CATALOG);
    expect(await runCapabilities({ kind: "workspace", root: "/w", chant: "0.124.46" }, w.reader)).toEqual({ ok: true, document: CATALOG });
    expect(w.calls).toEqual([{ argv: ["workspace", "search", "--capabilities", "--json"], root: "/w" }]);
    const tf = recording(CATALOG);
    await runCapabilities({ kind: "terraform", dir: "/tf", project: "/scratch", chant: "0.124.46" }, tf.reader);
    expect(tf.calls).toEqual([{ argv: ["search", "--capabilities", "--json"], root: "/scratch" }]);
  });

  it("refuses a chant below the floor before any call, and a document from before the contract", async () => {
    const r = recording(CATALOG);
    const old = await runCapabilities({ kind: "project", dir: "/p", chant: "0.124.45" }, r.reader);
    expect(old).toMatchObject({ ok: false, refusal: { code: "chant-too-old" } });
    expect(r.calls).toEqual([]);
    expect(CAPABILITIES_CHANT_FLOOR).toBe("0.124.46");
    expect(CHANT_FLOORS).toContain(floorFor("capability catalog"));
    const { contract: _c, ...noContract } = CATALOG;
    const bad = await runCapabilities({ kind: "project", dir: "/p", chant: "0.124.46" }, recording(noContract).reader);
    expect(bad).toMatchObject({ ok: false, refusal: { code: "workspace-contract" } });
    if (!bad.ok) expect(bad.refusal.error).toMatch(/^chant search --capabilities wrote/);
  });

  it("is listed in the API index", async () => {
    const body = (await (await createApp({ projectDir: tmpdir(), port: 0 }).request("http://localhost/api")).json()) as { routes: Array<{ path: string }> };
    expect(body.routes.map((r) => r.path)).toContain("/api/capabilities");
  });
});

describe("behold mcp's capabilities tool", () => {
  const SERVE = "http://127.0.0.1:4600";
  const TEXT = '{"$schema":"https://intentius.io/chant/schemas/workspace/capabilities/v1/capabilities.schema.json","contract":1,"chant":"0.124.46","capabilities":[],"helpers":[]}';
  const ctxOf = (o: { fetch: Fetch; url?: string; localCapabilities?: Context["localCapabilities"] }): Context => {
    const projectDir = realDir(tmpdir());
    return {
      projectDir,
      projectGiven: true,
      fetch: o.fetch,
      clientName: () => "test-agent",
      findServe: () => locateServe({ projectDir, projectGiven: true, fetch: o.fetch, registry: () => undefined, ...(o.url ? { url: o.url } : {}) }),
      localShot: async () => {
        throw new Error("no shot expected");
      },
      localSearch: async () => {
        throw new Error("no search expected");
      },
      localCapabilities: o.localCapabilities ?? (async () => {
        throw new Error("no local read expected");
      }),
    };
  };
  const serveAnswering = (status: number, text: string) => {
    const asked: string[] = [];
    const fetch: Fetch = async (url) => {
      const u = new URL(url);
      asked.push(u.pathname);
      if (u.pathname === "/api/project") return Response.json({ projectDir: realDir(tmpdir()), projectDirs: [] });
      if (u.pathname === "/api/capabilities") return new Response(text, { status, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 404 });
    };
    return { fetch, asked };
  };
  const nothingListens: Fetch = async (url) => {
    throw new TypeError(`fetch failed: connect ECONNREFUSED ${new URL(url).host}`);
  };
  const textOf = (r: CallToolResult): string => (r.content[0] as { text: string }).text;

  it("returns the serve's GET /api/capabilities body byte for byte", async () => {
    const s = serveAnswering(200, TEXT);
    const r = await callTool(TOOLS, "capabilities", {}, ctxOf({ fetch: s.fetch, url: SERVE }));
    expect(r.isError).toBeUndefined();
    expect(r.content).toHaveLength(1);
    expect(textOf(r)).toBe(TEXT);
    expect(s.asked).toEqual(["/api/project", "/api/capabilities"]);
  });

  it("with no serve, reads the same route of behold started in this process", async () => {
    let asked = 0;
    const r = await callTool(TOOLS, "capabilities", {}, ctxOf({ fetch: nothingListens, localCapabilities: async () => (asked++, { status: 200, text: TEXT }) }));
    expect(asked).toBe(1);
    expect(textOf(r)).toBe(TEXT);
  });

  it("a route refusal is a refusal, and the tool takes no argument", async () => {
    const r = await callTool(TOOLS, "capabilities", {}, ctxOf({ fetch: serveAnswering(422, JSON.stringify({ error: "Capability catalog needs chant 0.124.46 or newer.", code: "chant-too-old", remedy: "Upgrade." })).fetch, url: SERVE }));
    expect(r.isError).toBe(true);
    expect(JSON.parse(textOf(r))).toMatchObject({ code: "chant-too-old", status: 422 });
    const extra = await callTool(TOOLS, "capabilities", { query: "a" }, ctxOf({ fetch: nothingListens }));
    expect(extra.isError).toBe(true);
    expect(textOf(extra)).toMatch(/takes no argument query/);
  });
});

// ---------------------------------------------------------------------------
// Against the real chant: the ledger's Terraform form, a bare Terraform folder.
// ---------------------------------------------------------------------------

const LEDGER = join(import.meta.dirname, "__fixtures__", "capabilities-ledger");
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const peers = !!resolvedVersion(TERRAFORM_LEXICON_PKG) && !!resolvedVersion(HCL_PARSER_PKG);
const catalogued = meetsFloor(resolvedVersion("@intentius/chant"), CAPABILITIES_CHANT_FLOOR);
const gate = (!peers && !REQUIRE_PEERS) || !catalogued;
const why = `needs chant ${CAPABILITIES_CHANT_FLOOR} (INTENTIUS/chant#4375) and the terraform lexicon`;

/** What chant itself prints, run in the scratch project behold graphs the folder through. */
function chantSays(dir: string, argv: string[]): string {
  const scratch = writeTerraformScratchProject(dir, discoverTerraformRoots(dir), mkdtempSync(join(tmpdir(), "behold-926-chant-")));
  made.push(scratch);
  return spawnSync(join(scratch, "node_modules", ".bin", "chant"), argv, { cwd: scratch, encoding: "utf8" }).stdout.trim();
}

/** A hop end as a bare Terraform address: the card it is drawn on, without any member or root prefix. */
const bare = (id: string): string => id.split("#")[0]!.split("/").pop()!;

describe("the ledger's Terraform form, through the real chant", () => {
  const dir = gate ? "" : mkdtempSync(join(tmpdir(), "behold-926-"));
  if (!gate) {
    made.push(dir);
    cpSync(LEDGER, dir, { recursive: true });
  }
  let app: ReturnType<typeof createApp> | undefined;
  const ready = gate ? Promise.resolve() : localServeOptions(dir).then((cfg) => void (app = createApp(cfg)));

  it.skipIf(gate)(`cap:internet-reachable(22) lights the bastion's path to the internet gateway, each hop one of chant's because hops and an edge of the drawn graph (${why})`, { timeout: 180_000 }, async () => {
    await ready;
    const q = "cap:internet-reachable(22)";
    const res = await app!.request(`http://localhost/api/search?q=${encodeURIComponent(q)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draw: ReturnType<typeof drawnOf> };
    const chant = JSON.parse(chantSays(dir, ["search", "--explain", "--json", "--", q])) as {
      matches: Array<{ id: string; paths: Array<{ hops: Array<{ from: string; to: string }>; because?: Array<{ hops: Array<{ from: string; to: string }> }> }> }>;
    };
    const web = chant.matches.find((m) => bare(m.id) === "aws_instance.web");
    expect(web, "chant answers the bastion").toBeDefined();
    // The bastion's route is in because, not in its path's own hops.
    expect(web!.paths.flatMap((p) => p.hops)).toEqual([]);
    expect(body.draw.lit.map(bare)).toContain("aws_instance.web");
    expect(body.draw.onPath.map(bare)).toContain("aws_internet_gateway.igw");
    // What is drawn is exactly chant's hops, path and because, each on its card.
    const hopsOf = (m: (typeof chant.matches)[number]) => m.paths.flatMap((p) => [...p.hops, ...(p.because ?? []).flatMap((b) => b.hops)]);
    const want = new Set(chant.matches.flatMap(hopsOf).map((h) => `${bare(h.from)} ${bare(h.to)}`).filter((k) => k.split(" ")[0] !== k.split(" ")[1]));
    expect(new Set(body.draw.edges.map((h) => `${bare(h.from)} ${bare(h.to)}`))).toEqual(want);
    expect(want.has("aws_route.public_default aws_internet_gateway.igw")).toBe(true);
    // Each hop is an edge of the drawn graph, and each end a drawn card.
    // alike=0: every card drawn, none stacked into a "×3" card (#877).
    const graph = (await (await app!.request("http://localhost/api/graph?detail=2&alike=0")).json()) as { ir: { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string }> } };
    const edges = new Set(graph.ir.edges.flatMap((e) => [`${e.from} ${e.to}`, `${e.to} ${e.from}`]));
    const cards = new Set(graph.ir.nodes.map((n) => n.id));
    for (const h of body.draw.edges) expect(edges.has(`${h.from} ${h.to}`), `${h.from} -> ${h.to}`).toBe(true);
    for (const id of [...body.draw.lit, ...body.draw.onPath]) expect(cards.has(id), id).toBe(true);
  });

  it.skipIf(gate)(`GET /api/capabilities and behold mcp's capabilities answer chant's document byte for byte (${why})`, { timeout: 180_000 }, async () => {
    await ready;
    const said = chantSays(dir, ["search", "--capabilities", "--json"]);
    expect(JSON.parse(said)).toMatchObject({ contract: 1, $schema: "https://intentius.io/chant/schemas/workspace/capabilities/v1/capabilities.schema.json" });
    const res = await app!.request("http://localhost/api/capabilities");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.text()).toBe(said);
    const local = await localCapabilities(dir);
    expect(local).toEqual({ status: 200, text: said });
  });
});
