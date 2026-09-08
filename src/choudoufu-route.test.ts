import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";

// #371: the move routes over a two-member choudoufu estate on disk, with the
// choudoufu spawn answered from the recorded documents — no binary, no cloud.
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (name: string): string => readFileSync(join(HERE, "__fixtures__", name), "utf8");

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function estate(): { root: string; mono: string; teamA: string } {
  const root = mkdtempSync(join(tmpdir(), "behold-choudoufu-route-"));
  made.push(root);
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  write("mono/main.tf", 'terraform {\n  live {\n    estate = "tlmig-sample-monolith"\n  }\n}\n');
  write("mono/carve.json", raw("choudoufu-carve-plan.json"));
  write("team-a/main.tf", 'terraform {\n  live {\n    estate = "tlmig-sample-team-a"\n  }\n}\n');
  write("elsewhere/carve.json", "{}");
  return { root, mono: join(root, "mono"), teamA: join(root, "team-a") };
}

/** The spawn seam: live-check per member from its recorded roster, live-mv
 * from the recorded dry run or refusal, live-ls from the recorded listings.
 * Records every argv so a test can assert what was (not) run. */
function fakeChoudoufu(spawns: string[][]) {
  return async (args: string[], cwd: string) => {
    spawns.push(args);
    const verb = args[0];
    const inMono = cwd.endsWith("mono");
    if (verb === "live-check") return { code: 0, stderr: "", stdout: inMono ? raw("choudoufu-live-check-monolith.json") : raw("choudoufu-live-check-team-a.json") };
    if (verb === "live-mv") return { code: 0, stderr: "", stdout: args[4] === "aws_iam_role.team_b" ? raw("choudoufu-live-mv-refused.json") : raw("choudoufu-live-mv-cross-estate-dry-run.json") };
    if (verb === "live-ls") return { code: 0, stderr: "", stdout: inMono ? raw("choudoufu-live-ls-monolith.json") : raw("choudoufu-live-ls-team-a-after-split.json") };
    return { code: 2, stderr: `unexpected ${verb}`, stdout: "" };
  };
}

function served(spawns: string[][] = []) {
  const { mono, teamA } = estate();
  const broadcaster = new Broadcaster();
  const app = createApp(
    { projectDir: mono, projectDirs: [mono, teamA], port: 0, choudoufu: { run: fakeChoudoufu(spawns) } },
    broadcaster,
    new FrameBuffer(),
    new OpRunner({ projectDir: mono, broadcaster, onDone: () => {} }),
  );
  return { app, mono, teamA };
}

describe("GET /api/choudoufu/moves (#371)", () => {
  it("previews the plan: the lines, the destinations, the dry-run documents, the apply note", async () => {
    const spawns: string[][] = [];
    const { app } = served(spawns);
    const res = await app.request("/api/choudoufu/moves?plan=carve.json&dryrun=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { planPath: string; plan: { moves: number }; moves: Array<Record<string, unknown>>; apply: { human: boolean; note: string } };
    expect(body.planPath).toBe("carve.json");
    expect(body.plan.moves).toBe(4);
    expect(body.moves[0]).toMatchObject({
      address: "aws_iam_role.team_a",
      destination: { member: "team-a" },
      command: "choudoufu live-mv -from-estate=tlmig-sample-monolith aws_iam_role.team_a aws_iam_role.team_a",
      dryRun: { dry_run: true, followers: [{ address: "aws_iam_role_policy.team_a_inline" }, { address: "aws_iam_role_policy_attachment.team_a" }] },
    });
    expect(body.moves[3]).toMatchObject({ address: "aws_iam_role.team_b", runIn: expect.stringContaining("not served here") });
    expect(body.apply).toEqual({ human: true, note: expect.stringContaining("never runs the write") });
    // Every live-mv that ran was a dry run.
    const mv = spawns.filter((a) => a[0] === "live-mv");
    expect(mv).toHaveLength(3);
    for (const a of mv) expect(a).toContain("-dry-run");
  });

  it("without dryrun=1 spawns no live-mv at all; with receipt=1 reads the listings -consistent", async () => {
    const spawns: string[][] = [];
    const { app } = served(spawns);
    await app.request("/api/choudoufu/moves?plan=carve.json");
    expect(spawns.some((a) => a[0] === "live-mv")).toBe(false);
    const res = await app.request("/api/choudoufu/moves?plan=carve.json&receipt=1");
    const body = (await res.json()) as { receipt: { moves: Array<{ address: string; state: string }> } };
    expect(body.receipt.moves[0]).toEqual({ address: "aws_iam_role.team_a", to: "tlmig-sample-team-a", state: "moved" });
    expect(spawns.filter((a) => a[0] === "live-ls").every((a) => a.includes("-consistent"))).toBe(true);
  });

  it("refuses a plan outside the served members, a missing plan, and a plan that is not one", async () => {
    const { app } = served();
    expect((await app.request("/api/choudoufu/moves")).status).toBe(400);
    const outside = await app.request("/api/choudoufu/moves?plan=../elsewhere/carve.json");
    expect(outside.status).toBe(400);
    expect(((await outside.json()) as { code: string }).code).toBe("choudoufu_plan_outside");
    const notOne = await app.request("/api/choudoufu/moves?plan=main.tf");
    expect(notOne.status).toBe(422);
  });

  it("is advertised on /api, and /api/project lists the plans found", async () => {
    const { app } = served();
    const api = (await (await app.request("/api")).json()) as { routes: Array<{ path: string }> };
    expect(api.routes.some((r) => r.path === "/api/choudoufu/moves")).toBe(true);
    expect(api.routes.some((r) => r.path === "/choudoufu/morph")).toBe(true);
    const project = (await (await app.request("/api/project")).json()) as { choudoufu?: { plans: string[] }; environments: string[] };
    expect(project.choudoufu).toEqual({ plans: ["carve.json"] });
    expect(project.environments).toEqual(["live"]);
  });
});

describe("GET /choudoufu/morph (#371)", () => {
  it("renders every member as a box and the moved cards in their destination in the second frame", async () => {
    const { app } = served();
    const res = await app.request("/choudoufu/morph?plan=carve.json");
    expect(res.status).toBe(200);
    const html = await res.text();
    const VIEWS = JSON.parse(html.match(/const VIEWS = (\[[\s\S]*?\]);\n/)![1].replace(/\\u003c/g, "<")) as Array<{ name: string; boxes: Array<{ key: string; x: number }>; pos: Record<string, { x: number }> }>;
    expect(VIEWS.map((v) => v.name)).toEqual(["as the account stands", "after the plan's moves"]);
    const boxKeys = VIEWS[0]!.boxes.map((b) => b.key);
    expect(boxKeys).toContain("mono — choudoufu");
    expect(boxKeys).toContain("team-a — choudoufu");
    const teamABox = (v: (typeof VIEWS)[number]) => v.boxes.find((b) => b.key === "team-a — choudoufu")!;
    // The role keeps its id and moves right, into the team-a box; its followers with it.
    const before = VIEWS[0]!.pos["mono/aws_iam_role.team_a"]!.x;
    const after = VIEWS[1]!.pos["mono/aws_iam_role.team_a"]!.x;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(teamABox(VIEWS[1]!).x - 1000);
    expect(VIEWS[1]!.pos["mono/aws_iam_role_policy.team_a_inline"]!.x).toBeGreaterThan(VIEWS[0]!.pos["mono/aws_iam_role_policy.team_a_inline"]!.x);
  });
});

describe("what does not exist (#371)", () => {
  it("has no endpoint that runs live-mv — the move is a person, not a POST — and none is advertised", async () => {
    const { app } = served();
    for (const path of ["/api/choudoufu/mv", "/api/choudoufu/move", "/api/choudoufu/apply"]) {
      for (const method of ["POST", "GET"]) {
        const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    const api = (await (await app.request("/api")).json()) as { routes: Array<{ path: string; method: string }> };
    expect(api.routes.some((r) => r.path.startsWith("/api/choudoufu") && r.method !== "GET")).toBe(false);
  });
});
