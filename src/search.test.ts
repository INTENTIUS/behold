// behold#913: `q`, a chant search query drawn over the graph. The search goes
// through the workspace reader (src/search.ts); these hold the argv it sends,
// the floors, the refusals, and what the page draws from chant's document.
// The second half runs the real chant against a bare Terraform folder and
// compares what behold lights with what chant answers, gated on the chant
// that prints the read contract's search document.
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEARCH_CONTRACT_CHANT_FLOOR, SEARCH_TERRAFORM_WORKSPACE_CHANT_FLOOR, CHANT_FLOORS, floorFor } from "./chant-floors.ts";
import { meetsFloor } from "./floor.ts";
import { checkAsk, drawnOf, runSearch, SearchAskError, searchArgs, searchTarget } from "./search.ts";
import { projectSearchArgv, readArgv, workspaceReader, type TransportRun, type WorkspaceReader } from "./workspace-reader.ts";
import { createApp } from "./server.ts";
import { publicReadRefusal } from "./public-mode.ts";
import { canonicalKey, captureKeys, settleQueries } from "./export.ts";
import {
  discoverTerraformRoots,
  HCL_PARSER_PKG,
  readTerraformMember,
  resolvedVersion,
  TERRAFORM_LEXICON_PKG,
  terraformMemberWorkspace,
  terraformScratchDeclaration,
  writeTerraformScratchProject,
  writeTerraformScratchWorkspace,
} from "./terraform-member.ts";
import { askAnswer } from "./mcp.ts";
import { localSearch, localServeOptions } from "./shot-cli.ts";
import { estateMembers } from "./estate.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const HEAD = { $schema: "https://intentius.io/chant/schemas/workspace/search/v1/search.schema.json", contract: 1, chant: "0.124.46", at: null };

describe("the argv a search sends", () => {
  it("puts --json before the --, so a query that starts with -> stays one operand", () => {
    expect(readArgv("search", ["--explain", "--", "->kind:aws_vpc"])).toEqual(["workspace", "search", "--explain", "--json", "--", "->kind:aws_vpc"]);
    expect(projectSearchArgv(["--live", "--env", "prod", "--explain", "--", "kind:aws_instance"])).toEqual(["search", "--live", "--env", "prod", "--explain", "--json", "--", "kind:aws_instance"]);
    // The conformance suite's own read passes a bare word and no --.
    expect(readArgv("search", ["app"])).toEqual(["workspace", "search", "app", "--json"]);
  });

  it("follows the view: declared, live with env, a snapshot with env and snapshot; --explain always", () => {
    expect(searchArgs({ q: "a" })).toEqual(["--explain", "--", "a"]);
    expect(searchArgs({ q: "a", env: "prod" })).toEqual(["--live", "--env", "prod", "--explain", "--", "a"]);
    expect(searchArgs({ q: "a", env: "prod", snapshot: "latest" })).toEqual(["--snapshot", "latest", "--env", "prod", "--explain", "--", "a"]);
    expect(searchArgs({ q: "a", show: "instance_type,ami" })).toEqual(["--explain", "--show", "instance_type,ami", "--", "a"]);
  });

  it("checks the ask the way a link's q and snapshot are checked", () => {
    const refused = (raw: Parameters<typeof checkAsk>[0]): string => {
      try {
        checkAsk(raw);
      } catch (e) {
        return (e as SearchAskError).refusal.error;
      }
      return "";
    };
    expect(checkAsk({ q: "  ->kind:aws_vpc  " })).toEqual({ q: "->kind:aws_vpc" });
    expect(refused({ q: "" })).toMatch(/no query/);
    expect(refused({ q: "a\nb" })).toMatch(/control characters/);
    expect(refused({ q: "x".repeat(2001) })).toMatch(/at most 2000/);
    expect(refused({ q: "a", snapshot: "latest" })).toMatch(/a snapshot is of an env/);
    expect(refused({ q: "a", env: "prod;rm" })).toMatch(/isn't an env name/);
    expect(refused({ q: "a", show: "a b" })).toMatch(/comma list/);
  });
});

/** A reader that records its calls and answers `doc`. */
function recording(doc: Record<string, unknown>): { reader: (root: string) => WorkspaceReader; calls: string[][] } {
  const calls: string[][] = [];
  const run = async (argv: string[]): Promise<TransportRun> => {
    calls.push(argv);
    return { status: 0, stdout: JSON.stringify(doc), stderr: "" };
  };
  return { reader: () => workspaceReader({ run }), calls };
}

describe("runSearch: one chant call through the reader, behind the floor", () => {
  const doc = { ...HEAD, query: "a", source: { kind: "declared" }, matches: [], members: [] };

  it("reads a declared workspace with one chant workspace search, and hands the document back unchanged", async () => {
    const r = recording(doc);
    const read = await runSearch({ kind: "workspace", root: "/w", chant: "0.124.46" }, { q: "->a" }, r.reader);
    expect(read).toEqual({ ok: true, document: doc });
    expect(r.calls).toEqual([["workspace", "search", "--explain", "--json", "--", "->a"]]);
  });

  it("reads one project with plain chant search", async () => {
    const r = recording(doc);
    await runSearch({ kind: "project", dir: "/p", chant: "0.124.46" }, { q: "a", env: "prod" }, r.reader);
    expect(r.calls).toEqual([["search", "--live", "--env", "prod", "--explain", "--json", "--", "a"]]);
  });

  it("reads a bare Terraform folder with chant workspace search at its one-member scratch workspace (#925)", async () => {
    const roots: string[] = [];
    const r = recording(doc);
    const read = await runSearch({ kind: "terraform", dir: "/tf", root: "/tmp/behold-tfws-x", chant: "0.124.46" }, { q: "a", env: "prod" }, (root) => (roots.push(root), r.reader(root)));
    expect(read).toEqual({ ok: true, document: doc });
    expect(roots).toEqual(["/tmp/behold-tfws-x"]);
    expect(r.calls).toEqual([["workspace", "search", "--live", "--env", "prod", "--explain", "--json", "--", "a"]]);
  });

  it("refuses a bare Terraform folder on a chant without chant#4380 through src/chant-floors.ts (#925)", async () => {
    const r = recording(doc);
    const read = await runSearch({ kind: "terraform", dir: "/tf", root: "/w", chant: "0.124.45" }, { q: "a" }, r.reader);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.refusal.code).toBe("chant-too-old");
      expect(read.refusal.error).toContain(SEARCH_TERRAFORM_WORKSPACE_CHANT_FLOOR);
    }
    expect(r.calls).toEqual([]);
    expect(floorFor("search over a Terraform folder").floor).toBe(SEARCH_TERRAFORM_WORKSPACE_CHANT_FLOOR);
    expect(floorFor("search over a Terraform folder").adds).toContain("chant#4380");
  });

  it("refuses a chant below the floor through src/chant-floors.ts, before any call", async () => {
    const r = recording(doc);
    const read = await runSearch({ kind: "project", dir: "/p", chant: "0.124.45" }, { q: "a" }, r.reader);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.refusal.code).toBe("chant-too-old");
      expect(read.refusal.error).toContain(SEARCH_CONTRACT_CHANT_FLOOR);
    }
    expect(r.calls).toEqual([]);
    expect(CHANT_FLOORS).toContain(floorFor("search"));
  });

  it("refuses a search document from before the contract", async () => {
    const { contract: _c, $schema: _s, ...old } = doc;
    const read = await runSearch({ kind: "project", dir: "/p", chant: "0.124.46" }, { q: "a" }, recording(old).reader);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.refusal.code).toBe("workspace-contract");
      expect(read.refusal.error).toMatch(/^chant search wrote/);
    }
  });

  it("does no fan-out of its own: a loose estate is refused, a declared workspace is one target", () => {
    const base = { kindOf: () => "chant", chantOf: () => "0.124.46", memberOf: () => "tf", terraformWorkspace: (_d: string, m: string) => ({ root: `/s-${m}`, chant: "0.124.46" }) };
    expect(searchTarget({ ...base, workspace: undefined, dirs: ["/a", "/b"] })).toMatchObject({ kind: "refused", refusal: { code: "search-estate" } });
    expect(searchTarget({ ...base, workspace: { root: "/w", chant: "0.124.46" }, dirs: ["/w/a", "/w/b"] })).toEqual({ kind: "workspace", root: "/w", chant: "0.124.46" });
    expect(searchTarget({ ...base, workspace: undefined, dirs: ["/p"] })).toEqual({ kind: "project", dir: "/p", chant: "0.124.46" });
    expect(searchTarget({ ...base, kindOf: () => "terraform", workspace: undefined, dirs: ["/tf"] })).toEqual({ kind: "terraform", dir: "/tf", root: "/s-tf", chant: "0.124.46" });
    // #925: chant names the member, so a name its declaration refuses can't be searched under the cards' ids.
    let wrote = false;
    const odd = { ...base, kindOf: () => "terraform", memberOf: () => "My_Estate", terraformWorkspace: () => ((wrote = true), { root: "/x", chant: "0.124.46" }), workspace: undefined, dirs: ["/My_Estate"] };
    expect(searchTarget(odd)).toMatchObject({ kind: "refused", refusal: { code: "search-member-name" } });
    expect(wrote).toBe(false);
    expect(searchTarget({ ...base, kindOf: () => "choudoufu", workspace: undefined, dirs: ["/c"] })).toMatchObject({ kind: "refused", refusal: { code: "search-kind" } });
  });
});

describe("drawnOf: what the page draws from chant's document", () => {
  it("lights the matches and, once chant prints paths (chant#4359), the hops on them", () => {
    const d = drawnOf({
      ...HEAD,
      query: "kind:aws_instance ->*aws_vpc.main",
      provenance: "declared only",
      matches: [
        {
          id: "web",
          displayId: "web",
          kind: "Terraform::Resource",
          paths: [{ term: "->*x", dir: "out", hops: [{ from: "web", fromAttr: "subnet_id", to: "subnet", toAttr: "id" }, { from: "subnet", to: "vpc" }] }],
        },
      ],
    });
    expect(d.lit).toEqual(["web"]);
    expect(d.onPath.sort()).toEqual(["subnet", "vpc"]);
    expect(d.edges).toEqual([{ from: "web", fromAttr: "subnet_id", to: "subnet", toAttr: "id" }, { from: "subnet", to: "vpc" }]);
    expect(d.failure).toBeNull();
    expect(d.provenance).toBe("declared only");
  });

  it("before chant#4359 (no paths on a row) lights the matches and draws no path", () => {
    const d = drawnOf({ ...HEAD, query: "q", matches: [{ id: "web", displayId: "web", kind: "K" }, { id: "db", displayId: "db", kind: "K" }] });
    expect(d.lit).toEqual(["web", "db"]);
    expect(d.edges).toEqual([]);
    expect(d.onPath).toEqual([]);
  });

  it("no matches carries --explain's near-misses, at most eight", () => {
    const nearMisses = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, fails: "kind:nope" }));
    const d = drawnOf({ ...HEAD, query: "kind:nope", matches: [], explain: { universe: { matched: 0, of: 10, kinds: [] }, evidence: [], nearMisses, moreExcluded: 2 } });
    expect(d.lit).toEqual([]);
    expect(d.nearMisses.length).toBe(8);
    expect(d.failure).toBeNull();
  });

  it("a failed live read is a failure naming the lexicon, never an empty answer", () => {
    const d = drawnOf({
      ...HEAD,
      query: "q",
      source: { kind: "live", env: "prod" },
      matches: [{ id: "a", displayId: "a", kind: "K", unobserved: "read-failed" }],
      liveFailures: ["terraform: state read failed"],
    });
    expect(d.failure?.kind).toBe("live");
    expect(d.failure?.message).toContain("terraform: state read failed");
    expect(d.failure?.message).toContain("1/1 rows unobserved");
    expect(d.unobserved).toEqual({ a: "read-failed" });
    expect(d.lit).toEqual(["a"]);
  });

  it("a query chant refuses lights nothing and carries chant's message and hint", () => {
    const d = drawnOf({ ...HEAD, query: "effectiveIngress:tcp:22", error: { code: "query-invalid", message: "not a term", hint: "say attr:effectiveIngress=tcp:22" } });
    expect(d.failure).toEqual({ kind: "query", code: "query-invalid", message: "not a term", hint: "say attr:effectiveIngress=tcp:22" });
    expect(d.lit).toEqual([]);
  });

  it("names a member chant didn't search, never as one with no matches", () => {
    const d = drawnOf({
      ...HEAD,
      workspace: { name: "w", root: "." },
      query: "app",
      source: { kind: "declared" },
      members: [
        { name: "east", status: "searched", reason: null, matches: ["east/app"], provenance: "declared only", explain: { nearMisses: [{ id: "east/b", fails: "app" }] } },
        { name: "west", status: "failed", reason: { code: "member-chant-too-old", message: "old" } },
        { name: "tf", status: "skipped", reason: { code: "kind-not-run", message: "kind terraform" } },
      ],
      matches: [{ id: "east/app", member: "east", displayId: "app", kind: "K", paths: [] }],
    });
    expect(d.lit).toEqual(["east/app"]);
    expect(d.notSearched).toEqual([
      { member: "west", status: "failed", code: "member-chant-too-old", message: "old" },
      { member: "tf", status: "skipped", code: "kind-not-run", message: "kind terraform" },
    ]);
    expect(d.provenance).toBe("east: declared only");
    expect(d.nearMisses).toEqual([{ id: "east/b", fails: "app" }]);
  });
});

describe("a public view, and the export", () => {
  it("a public view answers a declared query and refuses env and snapshot", () => {
    expect(publicReadRefusal("/api/search", new URLSearchParams("q=a"))).toBeUndefined();
    expect(publicReadRefusal("/api/search", new URLSearchParams("q=a&env=prod"))).toMatch(/declared source only/);
    expect(publicReadRefusal("/api/search", new URLSearchParams("q=a&env=prod&snapshot=latest"))).toMatch(/declared source only/);
  });

  it("the route refuses a live query on --public too, and a request with no query", async () => {
    const app = createApp({ projectDir: tmpdir(), port: 0, public: true });
    expect((await app.request("http://localhost/api/search?q=a&env=prod")).status).toBe(403);
    const none = await createApp({ projectDir: tmpdir(), port: 0 }).request("http://localhost/api/search");
    expect(none.status).toBe(400);
    expect(((await none.json()) as { code: string }).code).toBe("bad-request");
  });

  it("captures each --q query for the source graph and each env, under the key the page asks with", () => {
    const keys = captureKeys({ environments: ["prod"], queries: ["->kind:aws_vpc"] });
    const page = (p: string) => canonicalKey("/api/search", new URLSearchParams(p));
    expect(keys).toContain(page("q=->kind:aws_vpc"));
    expect(keys).toContain(page("env=prod&q=->kind:aws_vpc"));
    expect(page("q=a&env=prod")).toBe(page("env=prod&q=a"));
    expect(page("env=prod&q=a&snapshot=latest")).not.toBe(page("env=prod&q=a"));
    expect(settleQueries(["a", " a ", "b"])).toEqual({ queries: ["a", "b"] });
    expect(settleQueries(["a\nb"])).toHaveProperty("error");
  });

  it("is listed in the API index", async () => {
    const body = (await (await createApp({ projectDir: tmpdir(), port: 0 }).request("http://localhost/api")).json()) as { routes: Array<{ path: string }> };
    expect(body.routes.map((r) => r.path)).toContain("/api/search");
  });
});

// ---------------------------------------------------------------------------
// Against the real chant: a bare Terraform folder, searched in the scratch
// project behold graphs it through.
// ---------------------------------------------------------------------------

const ESTATE = join(import.meta.dirname, "..", "example-terraform-estate");
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const peers = !!resolvedVersion(TERRAFORM_LEXICON_PKG) && !!resolvedVersion(HCL_PARSER_PKG);
const searchable = meetsFloor(resolvedVersion("@intentius/chant"), SEARCH_CONTRACT_CHANT_FLOOR);
const gate = (!peers && !REQUIRE_PEERS) || !searchable;
const why = `needs chant ${SEARCH_CONTRACT_CHANT_FLOOR} (INTENTIUS/chant#4374) and the terraform lexicon`;

/** A copy of the example estate without its declaration: a bare Terraform folder. */
function bareFolder(): string {
  const parent = mkdtempSync(join(tmpdir(), "behold-913-"));
  made.push(parent);
  // A name chant's declaration accepts: the folder's box, and so its workspace member, is named after it (#925).
  const dir = join(parent, "bare-estate");
  cpSync(ESTATE, dir, { recursive: true });
  rmSync(join(dir, "chant.workspace.json"));
  return dir;
}

/** What chant itself prints for the same search, run where behold runs it (#925): workspace search at the folder's one-member scratch workspace. */
function chantSays(dir: string, q: string, member: string): string {
  const { root } = terraformMemberWorkspace(dir, member);
  const run = spawnSync(join(root, "node_modules", ".bin", "chant"), readArgv("search", searchArgs({ q })), { cwd: root, encoding: "utf8" });
  return run.stdout.trim();
}

/** What behold drew before #925: plain search in the scratch project, each id put under the member's name by behold. */
function idsBefore925(dir: string, q: string, member: string): string[] {
  const scratch = writeTerraformScratchProject(dir, discoverTerraformRoots(dir), mkdtempSync(join(tmpdir(), "behold-925-before-")));
  made.push(scratch);
  const run = spawnSync(join(scratch, "node_modules", ".bin", "chant"), projectSearchArgv(searchArgs({ q })), { cwd: scratch, encoding: "utf8" });
  return (JSON.parse(run.stdout) as { matches: Array<{ id: string }> }).matches.map((m) => `${member}/${m.id}`);
}

/** Every path under `dir` with its size and mtime: what "nothing was written" is checked against. */
function snapshot(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map((p) => {
    const st = statSync(join(dir, p));
    return `${p} ${st.size} ${st.mtimeMs}`;
  }).sort();
}

interface Answer {
  document: Record<string, unknown> & { matches?: Array<{ id: string }> };
  draw: ReturnType<typeof drawnOf>;
  link: string;
}

describe("q on a bare Terraform folder, through the real chant", () => {
  const dir = gate ? "" : bareFolder();
  const before = gate ? [] : snapshot(dir);
  // Served the way `behold serve <dir>` serves it: a one-member estate, its cards under the member's name.
  let app: ReturnType<typeof createApp> | undefined;
  let member = "";
  const ready = gate
    ? Promise.resolve()
    : localServeOptions(dir).then((cfg) => {
        app = createApp(cfg);
        member = estateMembers(cfg.projectDirs ?? [dir])[0]!.name;
      });
  const ask = async (q: string): Promise<{ status: number; body: Answer & { code?: string; remedy?: string } }> => {
    await ready;
    const res = await app!.request(`http://localhost/api/search?q=${encodeURIComponent(q)}`);
    return { status: res.status, body: (await res.json()) as Answer & { code?: string; remedy?: string } };
  };

  it.skipIf(gate)(`lights exactly what chant search returns, and every lit id is a drawn card (${why})`, { timeout: 180_000 }, async () => {
    const { status, body } = await ask("kind:aws_s3_bucket");
    expect(status).toBe(200);
    const chant = JSON.parse(chantSays(dir, "kind:aws_s3_bucket", member)) as { matches: Array<{ id: string }> };
    expect(member).toBeTruthy();
    // #925: chant composes the member's ids, and the route hands them through unchanged.
    expect(body.draw.lit).toEqual(chant.matches.map((m) => m.id));
    expect(chant.matches.every((m) => m.id.startsWith(`${member}/`))).toBe(true);
    // The same ids behold drew when it prefixed plain search's rows itself.
    expect(body.draw.lit.slice().sort()).toEqual(idsBefore925(dir, "kind:aws_s3_bucket", member).sort());
    // chant's document is handed back as chant printed it.
    expect(JSON.stringify(body.document)).toBe(chantSays(dir, "kind:aws_s3_bucket", member));
    expect(body.draw.lit.length).toBeGreaterThan(0);
    const graph = (await (await app!.request("http://localhost/api/graph?detail=2")).json()) as { ir: { nodes: Array<{ id: string }> } };
    const drawn = new Set(graph.ir.nodes.map((n) => n.id));
    for (const id of body.draw.lit) expect(drawn.has(id), id).toBe(true);
    expect(body.draw.provenance).toMatch(/declared/);
    expect(body.link).toBe("http://localhost/?q=kind%3Aaws_s3_bucket");
  });

  it.skipIf(gate)(`a query that starts with -> lights the same nodes as the same terms reordered, and lights the path edges (${why})`, { timeout: 180_000 }, async () => {
    const a = await ask("->kind:aws_kms_key kind:aws_kms_alias");
    const b = await ask("kind:aws_kms_alias ->kind:aws_kms_key");
    expect(a.status).toBe(200);
    expect(a.body.draw.lit.length).toBeGreaterThan(0);
    expect(a.body.draw.lit.sort()).toEqual(b.body.draw.lit.sort());
    // #925: the lit set and the path ends are the ones behold drew before, when it prefixed them itself.
    expect(a.body.draw.lit.slice().sort()).toEqual(idsBefore925(dir, "->kind:aws_kms_key kind:aws_kms_alias", member).sort());
    // Each hop is an edge of the drawn graph.
    expect(a.body.draw.edges.length).toBeGreaterThan(0);
    const graph = (await (await app!.request("http://localhost/api/graph?detail=2")).json()) as { ir: { edges: Array<{ from: string; to: string }> } };
    const edges = new Set(graph.ir.edges.flatMap((e) => [`${e.from} ${e.to}`, `${e.to} ${e.from}`]));
    for (const h of a.body.draw.edges) expect(edges.has(`${h.from} ${h.to}`), `${h.from} -> ${h.to}`).toBe(true);
  });

  it.skipIf(gate)(`no matches answers the near-misses, never an empty answer (${why})`, { timeout: 180_000 }, async () => {
    const { status, body } = await ask("kind:aws_nothing_here");
    expect(status).toBe(200);
    expect(body.draw.lit).toEqual([]);
    expect(body.draw.nearMisses.length).toBeGreaterThan(0);
  });

  it.skipIf(gate)(`a query chant refuses answers 400 code query with chant's hint (${why})`, { timeout: 180_000 }, async () => {
    const { status, body } = await ask("effectiveIngress:tcp:22");
    expect(status).toBe(400);
    expect(body.code).toBe("query");
    expect(body.remedy).toMatch(/attr:/);
    expect(body.draw.lit).toEqual([]);
  });

  it.skipIf(gate)(`behold mcp's ask returns chant's document byte for byte, plus link and drawn (${why})`, { timeout: 180_000 }, async () => {
    const q = "->kind:aws_kms_key";
    const { status, body } = await localSearch(dir, new URLSearchParams({ q }));
    const { doc } = askAnswer(status, body);
    const { link, drawn, ...rest } = doc;
    expect(drawn).toBe(false);
    expect(link).toBe("http://localhost:4600/?q=-%3Ekind%3Aaws_kms_key");
    expect(JSON.stringify(rest)).toBe(chantSays(dir, q, estateMembers([dir])[0]!.name));
  });

  it.skipIf(gate)(`two roots: saved node= and focus= links keep naming the same cards, and chant's workspace graph gives the ids behold draws (#925, ${why})`, { timeout: 180_000 }, async () => {
    const { status, body } = await ask("kind:Terraform::Resource");
    expect(status).toBe(200);
    // The fixture has two roots, and both are lit under the folder's member name, each root as the scratch project names it.
    expect(body.draw.lit.some((id) => id.startsWith(`${member}/prod/`))).toBe(true);
    expect(body.draw.lit.some((id) => id.startsWith(`${member}/platform/`))).toBe(true);
    // And the cards are the ones drawn before #925: the member's name over the scratch project's own ids.
    const ir = await readTerraformMember(dir, {});
    const resourcesBefore = ir.nodes.filter((n) => n.kind === "Terraform::Resource").map((n) => `${member}/${n.id}`);
    expect(body.draw.lit.slice().sort()).toEqual(resourcesBefore.sort());
    // A saved link's node= or focus= is a card id. The graph route is untouched by #925, so every card it draws keeps
    // its id, and every resource card drawn is lit by a query for all resources.
    const graph = (await (await app!.request("http://localhost/api/graph?detail=2")).json()) as { ir: { nodes: Array<{ id: string; kind: string }> } };
    const all = new Set(ir.nodes.map((n) => `${member}/${n.id}`));
    const lit = new Set(body.draw.lit);
    for (const n of graph.ir.nodes) {
      if (!all.has(n.id)) continue;
      const own = ir.nodes.find((m) => `${member}/${m.id}` === n.id)!;
      if (own.kind === "Terraform::Resource") expect(lit.has(n.id), n.id).toBe(true);
    }
    expect(graph.ir.nodes.filter((n) => lit.has(n.id)).length).toBeGreaterThan(1);
    // chant's workspace graph over the same scratch workspace composes the same ids.
    const { root } = terraformMemberWorkspace(dir, member);
    const run = spawnSync(join(root, "node_modules", ".bin", "chant"), ["workspace", "graph"], { cwd: root, encoding: "utf8" });
    const doc = JSON.parse(run.stdout) as { nodes: Array<{ id: string; kind: string }> };
    expect(doc.nodes.filter((n) => n.kind === "Terraform::Resource").map((n) => n.id).sort()).toEqual(resourcesBefore.sort());
  });

  it.skipIf(gate)(`writes nothing in the served folder: the scratch workspace is under the OS temp directory (#925, ${why})`, { timeout: 180_000 }, async () => {
    await ask("kind:aws_s3_bucket");
    expect(snapshot(dir)).toEqual(before);
    const root = writeTerraformScratchWorkspace(dir, member, writeTerraformScratchProject(dir, discoverTerraformRoots(dir)));
    expect(root.startsWith(dir)).toBe(false);
    expect(readFileSync(join(root, "chant.workspace.json"), "utf8")).toBe(terraformScratchDeclaration(member));
    expect(snapshot(dir)).toEqual(before);
  });
});

// #925: the read-contract ruling on #908 says behold does no id prefixing.
// chant composes `<member>/<id>`, a bare Terraform folder's included, and the
// route draws chant's ids as printed.
describe("no id prefixing in the search route (#925)", () => {
  it("search.ts and the route in server.ts compose no ids of their own", () => {
    const search = readFileSync(join(import.meta.dirname, "search.ts"), "utf8");
    const server = readFileSync(join(import.meta.dirname, "server.ts"), "utf8");
    const route = server.slice(server.indexOf("const searchTargetNow"), server.indexOf('app.get("/api", '));
    expect(route.length).toBeGreaterThan(0);
    for (const src of [search, route]) {
      expect(src).not.toMatch(/drawnUnder/);
      expect(src).not.toMatch(/`\$\{(prefix|member|lone|name)\}\/\$\{/);
    }
    expect(route).toMatch(/const drawn = drawnOf\(read\.document\);/);
  });

  it("drawnOf hands chant's ids through unchanged", () => {
    const d = drawnOf({ ...HEAD, query: "a", matches: [{ id: "tf/prod/aws_s3_bucket.a", paths: [{ hops: [{ from: "tf/prod/aws_s3_bucket.a", to: "tf/prod/aws_kms_key.k" }] }] }], members: [{ name: "tf", status: "searched" }] });
    expect(d.lit).toEqual(["tf/prod/aws_s3_bucket.a"]);
    expect(d.onPath).toEqual(["tf/prod/aws_kms_key.k"]);
    expect(d.edges).toEqual([{ from: "tf/prod/aws_s3_bucket.a", to: "tf/prod/aws_kms_key.k" }]);
  });
});
