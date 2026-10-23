// behold#922: `countBy` and `plan`, demo steps 2, 3 and 5 through behold.
//
// The first half holds the contract with no chant: what a search sends, the
// view keys surviving a reload, a host's behold:view, POST /api/view, a shot
// and an export, the plan refused beside a snapshot, and the groups drawn from
// chant's counts document. The second half runs the real chant: the groups
// behold lights against the groups chant prints (a bare Terraform folder), and
// the plan depth against a real `terraform plan` of a local-backend
// `terraform_data` root (src/__fixtures__/terraform-plan-root).
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SEARCH_CONTRACT_CHANT_FLOOR, SEARCH_COUNT_BY_IDS_CHANT_FLOOR, TERRAFORM_PLAN_CHANT_FLOOR } from "./chant-floors.ts";
import { meetsFloor } from "./floor.ts";
import { checkAsk, drawnOf, drawnUnder, planRefusal, runSearch, SearchAskError, searchArgs, searchEnv, type SearchTarget } from "./search.ts";
import { projectSearchArgv, workspaceReader, type TransportRun, type WorkspaceReader } from "./workspace-reader.ts";
import { canonicalKey, captureKeys, settleCountBy } from "./export.ts";
import { moveView, type MoveContext } from "./view-move.ts";
import { queryView } from "./shot.ts";
import { publicReadRefusal } from "./public-mode.ts";
import { createApp } from "./server.ts";
import { localServeOptions } from "./shot-cli.ts";
import { estateMembers } from "./estate.ts";
import { discoverTerraformRoots, HCL_PARSER_PKG, resolvedVersion, TERRAFORM_LEXICON_PKG, writeTerraformScratchProject } from "./terraform-member.ts";
import { PLAN_READ_ENV } from "./terraform-plan.ts";
import { PLAN_SNAPSHOT_REASON, readViewQuery, restoreViewQuery, settleView, writeViewQuery, ZOOMS } from "../web/view-url.js";
import { viewFromMessage } from "../web/embed.js";
import { countsLine, groupLabel, groupMarks, queryLine, queryMarks, searchKey, searchUrl } from "../web/search-view.js";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const HEAD = { $schema: "https://intentius.io/chant/schemas/workspace/search/v1/search.schema.json", contract: 1, chant: "0.124.46", at: null };

/** chant's `--count-by kind --json`, as chant 0.124.46 prints it (INTENTIUS/chant#4360, #4382). */
const COUNTS = {
  ...HEAD,
  query: "kind:aws_",
  source: { kind: "declared" },
  countBy: "kind",
  groups: [
    { group: "aws_iam_role", count: 2, ids: ["app/aws_iam_role.a", "app/module.pod/aws_iam_role.b"] },
    { group: "aws_db_instance", count: 1, ids: ["app/aws_db_instance.orders"] },
    { group: "aws_vpc", count: 1, ids: ["app/aws_vpc.main"] },
  ],
  total: 4,
  provenance: "declared only · no observation · physical ids unavailable",
};

const refusedWith = (raw: Parameters<typeof checkAsk>[0]): string => {
  try {
    checkAsk(raw);
  } catch (e) {
    return (e as SearchAskError).refusal.error;
  }
  return "";
};

describe("what a countBy or plan search sends chant", () => {
  it("countBy is chant's --count-by, and with it no query counts the whole graph", () => {
    expect(checkAsk({ q: "kind:aws_", countBy: "module" })).toEqual({ q: "kind:aws_", countBy: "module" });
    expect(checkAsk({ q: "", countBy: "kind" })).toEqual({ q: "", countBy: "kind" });
    expect(searchArgs({ q: "kind:aws_", countBy: "kind" })).toEqual(["--explain", "--count-by", "kind", "--", "kind:aws_"]);
    expect(searchArgs({ q: "", countBy: "attr:region" })).toEqual(["--explain", "--count-by", "attr:region", "--", ""]);
    expect(refusedWith({ q: "a", countBy: "type" })).toMatch(/countBy was refused: countBy is kind, module or attr:<name>/);
    expect(refusedWith({ q: "" })).toMatch(/no query/);
  });

  it("plan is the plan depth: --live --env, CHANT_TERRAFORM_OBSERVE=plan, the placeholder env on a bare folder", () => {
    const ask = checkAsk({ q: "attr:planAction=replace", plan: "1" });
    expect(ask).toEqual({ q: "attr:planAction=replace", plan: true });
    expect(searchArgs(ask)).toEqual(["--live", "--env", PLAN_READ_ENV, "--explain", "--", "attr:planAction=replace"]);
    expect(searchArgs({ ...ask, env: "prod" })).toEqual(["--live", "--env", "prod", "--explain", "--", "attr:planAction=replace"]);
    expect(searchEnv(ask)).toEqual({ CHANT_TERRAFORM_OBSERVE: "plan" });
    expect(searchEnv({ q: "a" })).toBeUndefined();
    expect(checkAsk({ q: "a", plan: "0" })).toEqual({ q: "a" });
    expect(refusedWith({ q: "a", plan: "yes please" })).toMatch(/plan is 1 or 0/);
  });

  it("refuses plan with a snapshot, naming both", () => {
    const why = refusedWith({ q: "a", env: "prod", snapshot: "latest", plan: "1" });
    expect(why).toMatch(/plan and snapshot were both asked/);
  });

  it("a chant project gets no made-up env for its plan", async () => {
    const project: SearchTarget = { kind: "project", dir: "/p", chant: "0.124.46" };
    expect(planRefusal(project, { q: "a", plan: true })).toMatchObject({ code: "plan-env" });
    expect(planRefusal(project, { q: "a", plan: true, env: "prod" })).toBeUndefined();
    expect(planRefusal({ kind: "terraform", dir: "/t", project: "/s", chant: "0.124.46" }, { q: "a", plan: true })).toBeUndefined();
    const r = await runSearch(project, { q: "a", plan: true }, () => {
      throw new Error("no read expected");
    });
    expect(r).toMatchObject({ ok: false, refusal: { code: "plan-env" } });
  });

  it("runs the plan search with the lexicon's override in the environment of that one call", async () => {
    const envs: Array<Record<string, string> | undefined> = [];
    const argvs: string[][] = [];
    const reader = (_root: string, env?: Record<string, string>): WorkspaceReader => {
      envs.push(env);
      return workspaceReader({ run: async (argv): Promise<TransportRun> => (argvs.push(argv), { status: 0, stdout: JSON.stringify({ ...HEAD, query: "a", source: { kind: "live" }, matches: [] }), stderr: "" }) });
    };
    await runSearch({ kind: "terraform", dir: "/t", project: "/s", chant: "0.124.46" }, { q: "a", plan: true }, reader);
    expect(envs).toEqual([{ CHANT_TERRAFORM_OBSERVE: "plan" }]);
    expect(argvs[0]).toEqual(projectSearchArgv(["--live", "--env", PLAN_READ_ENV, "--explain", "--", "a"]));
  });

  it("a public view answers no plan search", () => {
    expect(publicReadRefusal("/api/search", new URLSearchParams({ q: "a", plan: "1" }))).toMatch(/declared source only/);
    expect(publicReadRefusal("/api/search", new URLSearchParams({ q: "a", countBy: "kind" }))).toBeUndefined();
  });
});

describe("the groups drawn from chant's counts document", () => {
  it("lights every group's ids, keeps chant's groups and total, and puts them under a lone folder's member", () => {
    const d = drawnOf(COUNTS);
    expect(d.counts).toEqual({ by: "kind", total: 4, groups: COUNTS.groups });
    expect(d.lit.sort()).toEqual(COUNTS.groups.flatMap((g) => g.ids).sort());
    const under = drawnUnder(d, "estate");
    expect(under.counts!.groups[0]!.ids).toEqual(["estate/app/aws_iam_role.a", "estate/app/module.pod/aws_iam_role.b"]);
    expect(under.lit).toContain("estate/app/aws_db_instance.orders");
  });

  it("a chant that lists no ids per group lights nothing and says so, never a wrong group", () => {
    const old = { ...COUNTS, groups: COUNTS.groups.map(({ group, count }) => ({ group, count })) };
    const d = drawnOf(old);
    expect(d.lit).toEqual([]);
    expect(d.counts!.groups.every((g) => g.ids === null)).toBe(true);
    expect(countsLine(d.counts)).toMatch(/lists no ids per group/);
  });

  it("each group's cards and label match chant's group and count, and the line shows the total", () => {
    const answer = { document: COUNTS, draw: drawnOf(COUNTS) };
    const cards = ["app/aws_iam_role.a", "app/module.pod/aws_iam_role.b", "app/aws_db_instance.orders", "app/aws_vpc.main", "app/aws_subnet.a"];
    const gm = groupMarks(answer, cards);
    expect(gm.groups.map((g: { group: string; count: number }) => ({ group: g.group, count: g.count }))).toEqual(COUNTS.groups.map(({ group, count }) => ({ group, count })));
    for (const [i, g] of COUNTS.groups.entries()) {
      expect(gm.groups[i].drawn).toEqual(g.ids);
      expect(gm.groups[i].label).toBe(g.ids[0]);
    }
    expect(groupLabel(gm.groups[0])).toBe("aws_iam_role · 2");
    expect(gm.cardGroup.has("app/aws_subnet.a")).toBe(false);
    const marks = queryMarks(answer, new Set(cards), []);
    expect(marks.cardMarks.get("app/aws_subnet.a")).toBe("dim");
    expect(marks.state).toBe("drawn");
    const line = queryLine({ q: "kind:aws_", countBy: "kind" }, answer, marks);
    expect(line.text).toContain("3 groups by kind: aws_iam_role 2, aws_db_instance 1, aws_vpc 1 · 4 total");
    expect(line.tone).toBe("ok");
  });
});

describe("plan and countBy are view keys", () => {
  const view = { q: "kind:aws_", countBy: "module", plan: true };

  it("survive a reload: written, read and settled back to the same view", () => {
    const search = writeViewQuery("", view);
    expect(search).toBe("?q=kind%3Aaws_&plan=1&countBy=module");
    const { apply, refused } = settleView(readViewQuery(search), { zooms: ZOOMS, envs: [] });
    expect(refused).toEqual([]);
    expect(apply).toMatchObject(view);
    expect(writeViewQuery("", apply)).toBe(search);
    // Back to a URL without them clears them.
    expect(restoreViewQuery("?zoom=resources")).toMatchObject({ plan: false, countBy: null });
  });

  it("survive a host's behold:view", () => {
    const host = "https://arugula.example";
    expect(viewFromMessage({ origin: host, data: { type: "behold:view", ...view } }, host)).toEqual(view);
    expect(viewFromMessage({ origin: host, data: { type: "behold:view", plan: false, countBy: null } }, host)).toEqual({ plan: false, countBy: null });
  });

  const ctx = (): MoveContext => ({ public: false, preview: false, offer: { envs: ["prod"] }, tabs: 1, origin: "http://127.0.0.1:4600", newId: () => "id", now: () => new Date(0) });

  it("survive POST /api/view: the tab gets them, and the link carries them", () => {
    const a = moveView({ view, by: "test" }, ctx());
    expect(a.status).toBe(200);
    expect(a.event!.view).toMatchObject(view);
    expect(a.body.link).toBe("http://127.0.0.1:4600/?q=kind%3Aaws_&plan=1&countBy=module");
    const bad = moveView({ view: { q: "a", countBy: "type", plan: "1" }, by: "test" }, ctx());
    expect(bad.body.refused).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "countBy", reason: "countBy is kind, module or attr:<name>" }),
        expect.objectContaining({ key: "plan", reason: "plan is true or false" }),
      ]),
    );
  });

  it("refuse plan beside a snapshot, naming both, on a link and on POST /api/view", () => {
    const { apply, refused } = settleView({ env: "prod", snapshot: "latest", plan: true }, { zooms: ZOOMS, envs: ["prod"] });
    expect(refused.map((r: { key: string }) => r.key).sort()).toEqual(["plan", "snapshot"]);
    for (const r of refused) expect(r.reason).toBe(PLAN_SNAPSHOT_REASON);
    expect(apply).not.toHaveProperty("plan");
    expect(apply).not.toHaveProperty("snapshot");
    const a = moveView({ view: { q: "a", env: "prod", snapshot: "latest", plan: true }, by: "test" }, ctx());
    expect((a.body.refused as Array<{ key: string }>).map((r) => r.key).sort()).toEqual(["plan", "snapshot"]);
  });

  it("survive a shot: the page the browser loads asks for them", () => {
    expect(queryView({ query: "kind:aws_", view: { plan: "1", countBy: "module" } })).toEqual({ q: "kind:aws_", plan: "1", countBy: "module" });
    // countBy alone frames the whole graph's groups.
    expect(queryView({ view: { countBy: "kind" } })).toEqual({ countBy: "kind" });
    expect(() => queryView({ query: "a", env: "prod", snapshot: "latest", view: { plan: "1" } })).toThrow(/plan=1 not opened.*snapshot=latest not opened/);
  });

  it("survive an export: the bundle holds the answer under the key the page asks with", () => {
    const keys = new Set(captureKeys({ environments: ["prod"], queries: ["kind:aws_"], countBy: "kind", plan: true }));
    const asks = (v: Record<string, unknown>): string => {
      const u = new URL(searchUrl(v), "http://x");
      return canonicalKey(u.pathname, u.searchParams);
    };
    for (const v of [
      { q: "kind:aws_" },
      { q: "kind:aws_", countBy: "kind" },
      { q: "kind:aws_", countBy: "kind", env: "prod" },
      { q: "kind:aws_", plan: true },
      { q: "kind:aws_", countBy: "kind", plan: true },
    ]) {
      expect(keys.has(asks(v)), JSON.stringify(v)).toBe(true);
    }
    // The plan's cards, as a view with plan=1 loads the source graph.
    expect(keys.has(canonicalKey("/api/graph", new URLSearchParams({ detail: "2", plan: "1" })))).toBe(true);
    // A grouping with no query counts the whole graph.
    expect(new Set(captureKeys({ environments: [], countBy: "module" })).has(asks({ countBy: "module" }))).toBe(true);
    // #404's one-shot plan on an overlay still replays the overlay as captured.
    expect(canonicalKey("/api/overlay", new URLSearchParams({ env: "prod", detail: "2", plan: "1" }))).toBe("/api/overlay?detail=2&env=prod");
    expect(settleCountBy("type")).toEqual({ error: '--count-by "type" was refused: countBy is kind, module or attr:<name>' });
  });

  it("a new grouping or plan is a new read", () => {
    const keys = new Set([searchKey({ q: "a" }), searchKey({ q: "a", countBy: "kind" }), searchKey({ q: "a", countBy: "module" }), searchKey({ q: "a", plan: true })]);
    expect(keys.size).toBe(4);
    expect(searchKey({ countBy: "kind" })).not.toBeNull();
    expect(searchUrl({ q: "a", env: "prod", snapshot: "latest", plan: true })).not.toContain("snapshot");
  });
});

// ---------------------------------------------------------------------------
// Against the real chant.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ESTATE = join(HERE, "..", "example-terraform-estate");
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const peers = !!resolvedVersion(TERRAFORM_LEXICON_PKG) && !!resolvedVersion(HCL_PARSER_PKG);
const chantVersion = resolvedVersion("@intentius/chant");
const searchable = meetsFloor(chantVersion, SEARCH_CONTRACT_CHANT_FLOOR) && meetsFloor(chantVersion, SEARCH_COUNT_BY_IDS_CHANT_FLOOR);
const gate = (!peers && !REQUIRE_PEERS) || !searchable;
const why = `needs chant ${SEARCH_CONTRACT_CHANT_FLOOR} (INTENTIUS/chant#4360, #4382) and the terraform lexicon`;

/** What chant itself prints for `--count-by`, run where behold runs it. */
function chantCounts(dir: string, q: string, countBy: string): { groups: Array<{ group: string; count: number; ids?: string[] }>; total: number } {
  const scratch = writeTerraformScratchProject(dir, discoverTerraformRoots(dir), mkdtempSync(join(tmpdir(), "behold-922-chant-")));
  made.push(scratch);
  const run = spawnSync(join(scratch, "node_modules", ".bin", "chant"), projectSearchArgv(searchArgs({ q, countBy })), { cwd: scratch, encoding: "utf8" });
  return JSON.parse(run.stdout) as { groups: Array<{ group: string; count: number; ids?: string[] }>; total: number };
}

describe("countBy on a bare Terraform folder, through the real chant", () => {
  const dir = gate ? "" : mkdtempSync(join(tmpdir(), "behold-922-"));
  if (!gate) {
    made.push(dir);
    cpSync(ESTATE, dir, { recursive: true });
    rmSync(join(dir, "chant.workspace.json"));
  }
  let app: ReturnType<typeof createApp> | undefined;
  let member = "";
  const ready = gate
    ? Promise.resolve()
    : localServeOptions(dir).then((cfg) => {
        app = createApp(cfg);
        member = estateMembers(cfg.projectDirs ?? [dir])[0]!.name;
      });

  for (const countBy of ["kind", "module"]) {
    it.skipIf(gate)(`lights each group's cards with chant's count, countBy=${countBy} (${why})`, { timeout: 180_000 }, async () => {
      await ready;
      const res = await app!.request(`http://localhost/api/search?q=&countBy=${countBy}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { document: { groups: unknown[]; total: number }; draw: ReturnType<typeof drawnOf>; link: string };
      const chant = chantCounts(dir, "", countBy);
      // chant's document, verbatim.
      expect(body.document.groups).toEqual(chant.groups);
      expect(body.document.total).toBe(chant.total);
      expect(chant.groups.every((g) => Array.isArray(g.ids))).toBe(true);
      // Drawn against every card of the graph: each group lights exactly its count, in chant's order.
      const graph = (await (await app!.request("http://localhost/api/graph?detail=3&alike=0")).json()) as { ir: { nodes: Array<{ id: string }> } };
      const drawn = new Set(graph.ir.nodes.map((n) => n.id));
      const gm = groupMarks({ document: body.document, draw: body.draw }, drawn);
      expect(gm.groups.map((g: { group: string; count: number }) => [g.group, g.count])).toEqual(chant.groups.map((g) => [g.group, g.count]));
      for (const [i, g] of chant.groups.entries()) {
        expect(gm.groups[i].ids).toEqual(g.ids!.map((id) => `${member}/${id}`));
        // Every id chant counted that the graph draws as a card is lit in its group.
        for (const id of gm.groups[i].drawn) expect(gm.cardGroup.get(id)).toBe(i);
      }
      expect(gm.total).toBe(chant.total);
      expect(body.link).toBe(`http://localhost/?countBy=${countBy}`);
    });
  }
});

const FIXTURE = join(HERE, "__fixtures__", "terraform-plan-root");
const which = spawnSync("sh", ["-c", "command -v terraform"], { encoding: "utf8" });
const TERRAFORM = which.status === 0 ? which.stdout.trim() : undefined;
const planGate = gate || !meetsFloor(chantVersion, TERRAFORM_PLAN_CHANT_FLOOR) || !meetsFloor(resolvedVersion(TERRAFORM_LEXICON_PKG), TERRAFORM_PLAN_CHANT_FLOOR) || !TERRAFORM;
const planWhy = `needs chant ${TERRAFORM_PLAN_CHANT_FLOOR} (INTENTIUS/chant#4358), the terraform lexicon and terraform on PATH`;

describe("plan=1 on a local-backend terraform_data root, real terraform", () => {
  it.skipIf(planGate)(`answers attr:planAction=replace with the replaced block, read from the plan (${planWhy})`, { timeout: 240_000 }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "behold-922-plan-"));
    made.push(tmp);
    const dir = join(tmp, "estate");
    cpSync(FIXTURE, dir, { recursive: true });
    const tf = (args: string[]) => {
      const r = spawnSync(TERRAFORM!, args, { cwd: dir, encoding: "utf8", env: { ...process.env, TF_IN_AUTOMATION: "1" } });
      if (r.status !== 0) throw new Error(`terraform ${args.join(" ")}: ${r.stderr}`);
    };
    tf(["init", "-input=false"]);
    tf(["apply", "-auto-approve", "-input=false", "-var", "token=s3cr3t-gen1"]);
    writeFileSync(join(dir, "terraform.tfvars"), 'generation = "2"\ntoken      = "s3cr3t-gen2"\n');
    const cfg = await localServeOptions(dir);
    const app = createApp(cfg);
    const member = estateMembers(cfg.projectDirs ?? [dir])[0]!.name;
    const q = encodeURIComponent("attr:planAction=replace");
    const res = await app.request(`http://localhost/api/search?q=${q}&plan=1&show=planActions,planReplacePaths,planActionReason`);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const body = JSON.parse(text) as { document: { matches: Array<{ id: string; show?: Record<string, unknown> }>; source: { kind: string } }; draw: ReturnType<typeof drawnOf>; link: string };
    expect(body.document.matches.map((m) => m.id)).toEqual(["estate/terraform_data.replaced"]);
    expect(body.document.matches[0]!.show).toMatchObject({ planReplacePaths: ["triggers_replace"], planActionReason: expect.any(String) });
    expect(body.draw.lit).toEqual([`${member}/estate/terraform_data.replaced`]);
    expect(body.link).toBe(`http://localhost/?q=${q}&plan=1`);
    expect(text).not.toContain("s3cr3t-gen2");
    // Without plan, the declared source has no planAction to match.
    const declared = (await (await app.request(`http://localhost/api/search?q=${q}`)).json()) as { draw: ReturnType<typeof drawnOf> };
    expect(declared.draw.lit).toEqual([]);
    // And never beside a snapshot.
    const both = await app.request(`http://localhost/api/search?q=${q}&plan=1&env=prod&snapshot=latest`);
    expect(both.status).toBe(400);
    expect(((await both.json()) as { error: string }).error).toMatch(/plan and snapshot/);
  });
});
