import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { LAST_APPLY, lastRelease, memberRunsCard, withMemberApplies, withReleases, withRunsSince } from "./component-releases.ts";
import { estateComponents } from "./estate-components.ts";
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
    expect(r.ir.nodes[0]!.attrs.release).toBe("016d066 · 2026-10-22");
    expect(r.ir.nodes[1]!.attrs.release).toBeUndefined();
    expect((r.ir.nodes[2]!.attrs._release as { runId: string }).runId).toBe("kept");
  });

  it("reads a single project's components by their own names", async () => {
    const r = await withReleases(ir("site"), [{ dir: "/p" }], undefined, async () => ({ found: true, cells: [cell("site", "local", "2026-10-21T09:00:00Z")] }));
    expect(r.ir.nodes[0]!.attrs.release).toBe("016d066 · 2026-10-21");
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

  // #997: a choudoufu member has no component release; its one card takes its
  // last apply and the failed run after it from the run index.
  describe("a member chant records no release for", () => {
    const run = (job: string, status: string, ended: string, commit: string, member?: string): CiRunEntry =>
      ({ job, status, ended, started: ended, commit, runId: `chant-${ended}`, key: `1/${commit}${member ? `/${member}` : ""}`, pr: 1, runOrigin: { forge: "github", url: "https://github.com/o/r/actions/runs/7" }, ...(member ? { member } : {}) }) as CiRunEntry;
    // The estate the components route composes: a chant member with a component, and a choudoufu member as its one card.
    const picture = (): GraphIR => {
      const entity = { nodes: [{ id: "site/azurerm_storage_account.web", kind: "azurerm_storage_account", lexicon: "choudoufu", attrs: {} }], edges: [], groups: {} } as unknown as GraphIR;
      return estateComponents(
        [
          { member: "dns", dag: ir("records") },
          { member: "site", dag: { nodes: [memberRunsCard("choudoufu")], edges: [], groups: {} } as unknown as GraphIR },
        ],
        entity,
      ).ir;
    };

    it("shows a choudoufu member's last apply and a failed run since", async () => {
      const { ir: released } = await withReleases(picture(), [{ name: "dns", dir: "/w/dns" }, { name: "site", dir: "/w/site" }], undefined, async () => ({ found: false, cells: [] }));
      const runs = [
        run("apply", "ok", "2026-10-22T03:00:00Z", "1111111aaaaaaa", "site"),
        run("apply", "ok", "2026-10-22T04:00:00Z", "2222222bbbbbbb", "site"),
        // A run of the whole workspace names no member, so it is not taken as this member's apply.
        run("apply", "ok", "2026-10-22T04:15:00Z", "9999999fffffff"),
        run("plan", "ok", "2026-10-22T04:30:00Z", "3333333ccccccc", "site"),
        run("apply", "fail", "2026-10-22T05:00:00Z", "4444444ddddddd", "site"),
      ];
      const r = withMemberApplies(withRunsSince(released, runs).ir, runs, true);
      expect(r.applied).toBe(1);
      const card = r.ir.nodes.find((n) => n.id === "site/choudoufu")!;
      expect(card.attrs.engine).toBe("choudoufu");
      expect(card.attrs.apply).toBe("2222222 · 2026-10-22");
      expect(card.attrs[LAST_APPLY]).toMatchObject({ commit: "2222222bbbbbbb", ended: "2026-10-22T04:00:00Z", forge: "github", url: "https://github.com/o/r/actions/runs/7" });
      expect(card.attrs.since).toBe("apply failed 4444444");
      expect(card.attrs._runSince).toMatchObject({ job: "apply", status: "fail", commit: "4444444ddddddd", member: "site" });
      // Another member's failure is not this card's.
      const other = [...runs, run("apply", "fail", "2026-10-22T07:00:00Z", "5555555eeeeeee", "dns"), run("apply", "ok", "2026-10-22T06:00:00Z", "6666666aaaaaaa", "site")];
      expect(withMemberApplies(released, other, true).ir.nodes.find((n) => n.id === "site/choudoufu")!.attrs.since).toBeUndefined();
      // The member is one card in its own box, and the chant member's component is untouched.
      expect(r.ir.groups.byStack).toMatchObject({ site: ["site/choudoufu"], dns: ["dns/records"] });
      expect(r.ir.nodes.find((n) => n.id === "dns/records")!.attrs.apply).toBeUndefined();
    });

    it("says no runs are recorded, rather than inventing one, when the index names none of the member", () => {
      const runs = [run("apply", "ok", "2026-10-22T03:00:00Z", "1111111aaaaaaa", "dns")];
      const card = withMemberApplies(picture(), runs, true).ir.nodes.find((n) => n.id === "site/choudoufu")!;
      expect(card.attrs.runs).toBe("no runs recorded");
      expect(card.attrs.apply).toBeUndefined();
      expect(card.attrs[LAST_APPLY]).toBeUndefined();
      expect(withMemberApplies(picture(), [], false).ir.nodes.find((n) => n.id === "site/choudoufu")!.attrs.runs).toBe("no run index read");
    });

    it("shows a member's failed run when no apply of it ever passed", () => {
      const runs = [run("apply", "fail", "2026-10-22T03:00:00Z", "1111111aaaaaaa", "site")];
      const card = withMemberApplies(picture(), runs, true).ir.nodes.find((n) => n.id === "site/choudoufu")!;
      expect(card.attrs.apply).toBe("none recorded");
      expect(card.attrs.since).toBe("apply failed 1111111");
    });
  });
});
