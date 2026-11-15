import { describe, it, expect, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkDemoPins } from "./demo-pins.ts";
import { resetMemberIrCache, type MemberVia } from "./member-ir.ts";
import { createApp } from "./server.ts";
import { localServeOptions } from "./shot-cli.ts";
import { resolvedVersion } from "./terraform-member.ts";
import { CONTRACT_READ_KINDS, setServedWorkspace, workspaceVia, type WorkspaceMember } from "./workspace.ts";

// CI's `peers` job sets BEHOLD_REQUIRE_PEERS=1 (scripts/install-peers.sh): there a
// missing peer fails the test instead of skipping it.
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";

// behold#1056: the kustomize, argo-app, flux-kustomization, helm-chart and
// cloudformation member kinds, read through chant's `workspace graph --member`
// with the detail tier passed on. The kinds are supplied by the k8s, helm and
// aws lexicons' workspace-kinds.json (INTENTIUS/chant#3179). The fixture,
// e2e/fixtures/k8s-workspace, is one kustomize member (a Deployment and a
// Service) and one Argo CD Application whose spec.source.path names it.
const FIXTURE = join(import.meta.dirname, "..", "e2e", "fixtures", "k8s-workspace");

afterAll(() => {
  setServedWorkspace(undefined);
  resetMemberIrCache();
});

describe("the kubernetes, helm and cloudformation member kinds (behold#1056)", () => {
  it("are read through the workspace contract", () => {
    for (const kind of ["kustomize", "argo-app", "flux-kustomization", "helm-chart", "cloudformation"]) {
      expect(CONTRACT_READ_KINDS.has(kind), kind).toBe(true);
    }
  });

  it("send a lens to the member's own chant graph, not the contract", async () => {
    const member: WorkspaceMember = { name: "web", dir: "apps/web", kind: "kustomize", abs: join(FIXTURE, "apps/web"), reason: null, because: null };
    const read = vi.fn(async () => ({ nodes: [], edges: [], groups: {} }) as never);
    const fallback: MemberVia = { tool: () => "own", read };
    const via = workspaceVia(member, FIXTURE, fallback);
    await via.read(member.abs, { lens: "k8s" });
    await via.read(member.abs, { up: true });
    await via.read(member.abs, { namespace: "web" });
    expect(read).toHaveBeenCalledTimes(3);
  });
});

// The e2e: the fixture served the way `behold serve <workspace>` serves it,
// through the real chant installed beside behold, from a copy under the OS
// temp directory re-pinned at the installed lexicon (src/demo-pins.ts). A
// kustomize member is rendered by `kustomize` or `kubectl kustomize`.
const K8S_LEXICON_PKG = "@intentius/chant-lexicon-k8s";
const INSTALLED = resolvedVersion(K8S_LEXICON_PKG);
const hasRenderer = ["kustomize", "kubectl"].some((bin) => spawnSync(bin, ["version", "--client"], { stdio: "ignore" }).status === 0);
const gate = (!INSTALLED || !hasRenderer) && !REQUIRE_PEERS;
const why = `needs ${K8S_LEXICON_PKG} installed beside behold (a devDependency of behold) and kustomize or kubectl on PATH`;
const COPY = gate ? "" : mkdtempSync(join(tmpdir(), "behold-k8s-workspace-"));
afterAll(() => {
  if (COPY) rmSync(COPY, { recursive: true, force: true });
});

interface Drawn {
  error?: string;
  ir: {
    nodes: Array<{ id: string; kind: string; attrs: Record<string, unknown> }>;
    edges: Array<{ from: string; to: string; viaAttr?: string }>;
  };
}

describe("a kustomize and an argo-app member in a chant workspace render, through the real chant (behold#1056)", () => {
  let app: ReturnType<typeof createApp> | undefined;
  const ready = gate
    ? Promise.resolve()
    : Promise.resolve()
        .then(() => {
          cpSync(FIXTURE, COPY, { recursive: true });
          const pins = linkDemoPins(COPY);
          if (!pins.ok) throw new Error(`${pins.error} ${pins.remedy}`);
          return localServeOptions(COPY);
        })
        .then((cfg) => {
          resetMemberIrCache();
          app = createApp(cfg);
        });

  const graph = async (query: string): Promise<Drawn> => {
    await ready;
    const res = await app!.request(`http://localhost/api/graph${query}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Drawn;
    expect(body.error).toBeUndefined();
    return body;
  };

  it.skipIf(gate)(`detail 3 returns both members' objects with metadata and spec (${why})`, { timeout: 120_000 }, async () => {
    const body = await graph("?detail=3");
    expect(body.ir.nodes.some((n) => n.kind === "UnreadableMember")).toBe(false);
    expect(body.ir.nodes.map((n) => n.id).sort()).toEqual(["web-app/web-app/applicationWeb", "web/web/deploymentWeb", "web/web/serviceWeb"]);
    for (const n of body.ir.nodes) {
      expect(n.attrs.metadata, n.id).toBeDefined();
      expect(n.attrs.spec, n.id).toBeDefined();
    }
  });

  it.skipIf(gate)(`the Application gets its path edge to the kustomize member (${why})`, { timeout: 120_000 }, async () => {
    const body = await graph("?detail=3");
    expect(body.ir.edges).toContainEqual(expect.objectContaining({ from: "web-app/web-app/applicationWeb", to: "web/web/serviceWeb", viaAttr: "delivers" }));
  });

  it.skipIf(gate)(`at the default detail the nodes carry no spec, so there is no path edge (${why})`, { timeout: 120_000 }, async () => {
    const body = await graph("");
    expect(body.ir.nodes).toHaveLength(3);
    expect(body.ir.nodes.every((n) => n.attrs.spec === undefined)).toBe(true);
    expect(body.ir.edges.some((e) => e.viaAttr === "delivers")).toBe(false);
  });

  it.skipIf(gate)(`a lens read goes to each member's own chant graph, which cannot read an overlay directory (${why})`, { timeout: 120_000 }, async () => {
    const body = await graph("?detail=3&lens=k8s");
    expect(body.ir.nodes.map((n) => n.kind)).toEqual(["UnreadableMember", "UnreadableMember"]);
  });
});
