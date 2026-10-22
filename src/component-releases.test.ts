import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { lastRelease, withReleases, withRunsSince } from "./component-releases.ts";
import type { CiRunEntry } from "./ci-run-index.ts";
import type { ReleaseCell } from "./lifecycle-releases.ts";

const cell = (component: string, env: string, timestamp: string, extra: Partial<ReleaseCell> = {}): ReleaseCell =>
  ({ component, env, timestamp, digest: `jcs1-sha256:${component}${env}`, actor: "test", gitSha: "016d066dabf7534d", runId: `local-${timestamp}`, source: { branch: "chant/lifecycle", path: "" }, ...extra }) as ReleaseCell;

const ir = (...ids: string[]): GraphIR => ({ nodes: ids.map((id) => ({ id, kind: "Component", lexicon: "chant", attrs: { archetype: "infra" } })), edges: [], groups: {} }) as unknown as GraphIR;

describe("component releases (#899)", () => {
  it("takes the newest release, in the environment asked for or any", () => {
    const answer = { cells: [cell("site", "local", "2026-10-22T01:00:00Z"), cell("site", "prod", "2026-10-22T02:00:00Z")] };
    expect(lastRelease(answer, "site", "local")?.timestamp).toBe("2026-10-22T01:00:00Z");
    expect(lastRelease(answer, "site")?.timestamp).toBe("2026-10-22T02:00:00Z");
    expect(lastRelease(answer, "other")).toBeUndefined();
  });

  it("says where the run lives from the record, and never makes a link the record doesn't carry", () => {
    const local = lastRelease({ cells: [cell("site", "local", "t", { runOrigin: { forge: "local" } })] }, "site")!;
    expect(local).toMatchObject({ forge: "local", originSource: "record" });
    expect(local.url).toBeUndefined();
    const gh = lastRelease({ cells: [cell("site", "local", "t", { runOrigin: { forge: "github", url: "https://github.com/o/r/actions/runs/1" } })] }, "site")!;
    expect(gh.url).toBe("https://github.com/o/r/actions/runs/1");
  });

  it("gives each member's component card its own member's release, and leaves a card with one alone", async () => {
    const answers: Record<string, { found: boolean; cells: ReleaseCell[] }> = {
      "/w/aws": { found: true, cells: [cell("site", "local", "2026-10-22T01:00:00Z", { runOrigin: { forge: "local" } })] },
      "/w/gcp": { found: false, cells: [] },
    };
    const graph = ir("aws/site", "gcp/site", "dns/records");
    graph.nodes[2]!.attrs._release = { runId: "kept" };
    const r = await withReleases(graph, [{ name: "aws", dir: "/w/aws" }, { name: "gcp", dir: "/w/gcp" }, { name: "dns", dir: "/w/dns" }], "local", async (dir) => answers[dir] ?? { found: false, cells: [] });
    expect(r.released).toBe(2);
    expect(r.ir.nodes[0]!.attrs.release).toBe("016d066 via laptop");
    expect(r.ir.nodes[1]!.attrs.release).toBeUndefined();
    expect((r.ir.nodes[2]!.attrs._release as { runId: string }).runId).toBe("kept");
  });

  it("reads a single project's components by their own names", async () => {
    const r = await withReleases(ir("site"), [{ dir: "/p" }], undefined, async () => ({ found: true, cells: [cell("site", "local", "t")] }));
    expect(r.ir.nodes[0]!.attrs.release).toBe("016d066 via laptop");
  });

  it("marks a card with the newest run after its release that did not pass, for its member or the whole workspace", () => {
    const run = (job: string, status: string, ended: string, member?: string): CiRunEntry =>
      ({ job, status, ended, started: ended, commit: "8aa41eb3bbdc990783b98a4c252498ff461cfd10", runId: `chant-${ended}`, key: "1/x", pr: 1, runOrigin: { forge: "chant" }, ...(member ? { member } : {}) }) as CiRunEntry;
    const graph = ir("aws/site", "gcp/site", "dns/records");
    graph.nodes[0]!.attrs._release = { timestamp: "2026-10-22T05:00:00Z" };
    graph.nodes[1]!.attrs._release = { timestamp: "2026-10-22T05:00:00Z" };
    const r = withRunsSince(graph, [
      run("apply", "fail", "2026-10-22T04:00:00Z"),
      run("plan", "fail", "2026-10-22T05:10:00Z"),
      run("apply", "ok", "2026-10-22T05:20:00Z", "gcp"),
    ]);
    expect(r.marked).toBe(1);
    expect(r.ir.nodes[0]!.attrs.since).toBe("plan failed 8aa41eb");
    expect(r.ir.nodes[0]!.attrs._runSince).toMatchObject({ job: "plan", status: "fail" });
    expect(r.ir.nodes[1]!.attrs.since).toBeUndefined();
    expect(r.ir.nodes[2]!.attrs.since).toBeUndefined();
  });
});
