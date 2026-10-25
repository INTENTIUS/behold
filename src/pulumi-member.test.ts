import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMemberKind, memberKindOf } from "./member-kind.ts";
import { resetMemberIrCache } from "./member-ir.ts";
import { createApp } from "./server.ts";
import { localServeOptions } from "./shot-cli.ts";
import { resolvedVersion } from "./terraform-member.ts";
import {
  CONTRACT_READ_KINDS,
  memberIrFromGraphDocument,
  PULUMI_NO_LIVE_READ,
  pulumiWorkspaceVia,
  setServedWorkspace,
  type WorkspaceMember,
} from "./workspace.ts";

// CI's `peers` job sets BEHOLD_REQUIRE_PEERS=1 (scripts/install-peers.sh): there a
// missing peer fails the test instead of skipping it.
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";

// behold#994: a `pulumi` member of a chant workspace, read through chant's
// `workspace graph --member`, which reads the `pulumi stack export` checked in
// beside the member's Pulumi.yaml (INTENTIUS/chant#3179). The kind is
// supplied by @intentius/chant-lexicon-pulumi since chant#4453 (C3), and the
// graph has no node for the stack root since chant#4456 (C6). Provenance:
//  - e2e/fixtures/pulumi-workspace: one member, `app`, whose Pulumi.yaml and
//    stack-export.json are chant's own testdata/pulumi-member at chant
//    8cd73461a. The declaration pins the pulumi lexicon at 0.124.34, the
//    version its package.json carries on chant's integration/pulumi-engine.
//  - __fixtures__/pulumi-workspace-graph-app.json: `chant workspace graph .
//    --member app --json` in that fixture, unedited, by chant from
//    integration/pulumi-engine at a20de35a1 (it reports 0.124.34), with that
//    branch's lexicons/pulumi installed beside behold (behold#999).
const FIXTURE = join(import.meta.dirname, "..", "e2e", "fixtures", "pulumi-workspace");
const GRAPH = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "pulumi-workspace-graph-app.json"), "utf8")) as Record<string, unknown>;
const member: WorkspaceMember = { name: "app", dir: "app", kind: "pulumi", abs: join(FIXTURE, "app"), reason: null, because: null };

/** The export's five resources (the provider and the stack root left out), as chant names them under the member. */
const RESOURCES = [
  "app/aws:iam/role:Role::web",
  "app/aws:iam/rolePolicy:RolePolicy::webReadsAssets",
  "app/aws:s3/bucket:Bucket::assets",
  "app/my:mod:Web$aws:lambda/function:Function::handler",
  "app/my:mod:Web::web-app",
];

afterAll(() => {
  setServedWorkspace(undefined);
  resetMemberIrCache();
});

describe("the pulumi member kind (behold#994)", () => {
  it("is a word behold knows and a kind chant reads through the contract, keyed on the kind string", () => {
    expect(isMemberKind("pulumi")).toBe(true);
    expect(CONTRACT_READ_KINDS.has("pulumi")).toBe(true);
    // No row of behold's own claims the directory: chant's read is the only one.
    expect(memberKindOf(member.abs)).toBeUndefined();
  });

  it("composes chant's recorded document into the member's resources and its parent and dependency edges", () => {
    const ir = memberIrFromGraphDocument(GRAPH(), "app");
    expect(ir.nodes.map((n) => n.id).sort()).toEqual(RESOURCES);
    const bucket = ir.nodes.find((n) => n.id === "app/aws:s3/bucket:Bucket::assets")!;
    expect(bucket.kind).toBe("aws:s3/bucket:Bucket");
    // behold never invents a colour: the source read carries no status at all.
    expect(ir.nodes.every((n) => n.attrs?._status === undefined)).toBe(true);
    // Three dependencies and the lambda's parent; a parent that is the stack root draws no edge (chant#4456).
    expect(ir.edges).toHaveLength(4);
    expect(ir.edges.filter((e) => e.viaAttr === "dependencies")).toHaveLength(3);
    expect(ir.nodes.every((n) => n.kind !== "pulumi:pulumi:Stack")).toBe(true);
    // chant's report of what it read rides on the member's meta.
    expect((ir as unknown as { meta?: { pulumiMember?: unknown } }).meta?.pulumiMember).toEqual({ export: "stack-export.json", objects: 5, exported: true });
  });

  it("has no live read: a live or overlay read is refused before anything is spawned", async () => {
    const via = pulumiWorkspaceVia(member, FIXTURE);
    await expect(via.read(member.abs, { live: true, overlay: true, env: "dev" })).rejects.toThrow(PULUMI_NO_LIVE_READ);
    await expect(via.read(member.abs, { overlay: true })).rejects.toThrow(PULUMI_NO_LIVE_READ);
  });
});

// The e2e: the fixture served the way `behold serve e2e/fixtures/pulumi-workspace`
// serves it, through the real chant installed beside behold, which finds the
// pinned lexicon in behold's own node_modules. Nothing is written under the
// fixture: chant writes its reader project under the OS temp directory.
// chant reads the kinds of a pinned package only at the version the pin names,
// so the gate is that the installed pulumi lexicon is the pinned one, read
// from the declaration, rather than a floor.
const PULUMI_LEXICON_PKG = "@intentius/chant-lexicon-pulumi";
const PINNED = ((JSON.parse(readFileSync(join(FIXTURE, "chant.workspace.json"), "utf8")) as { pins: Array<{ package: string; version: string }> }).pins.find((p) => p.package === PULUMI_LEXICON_PKG) ?? { version: "" }).version;
const peers = resolvedVersion(PULUMI_LEXICON_PKG) === PINNED;
const gate = !peers && !REQUIRE_PEERS;
const why = `needs ${PULUMI_LEXICON_PKG} ${PINNED} (INTENTIUS/chant#4453), the version the fixture pins, installed beside behold`;

interface Drawn {
  error?: string;
  svg?: string;
  ir: { nodes: Array<{ id: string; kind: string; attrs: Record<string, unknown> }>; edges: unknown[] };
}

describe("a pulumi member in a chant workspace renders, through the real chant (behold#994)", () => {
  let app: ReturnType<typeof createApp> | undefined;
  const ready = gate
    ? Promise.resolve()
    : localServeOptions(FIXTURE).then((cfg) => {
        resetMemberIrCache();
        app = createApp(cfg);
      });

  it.skipIf(gate)(`draws the export's resources, not an unreadable box (${why})`, { timeout: 120_000 }, async () => {
    await ready;
    const res = await app!.request("http://localhost/api/graph");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Drawn;
    expect(body.error).toBeUndefined();
    expect(body.ir.nodes.some((n) => n.kind === "UnreadableMember")).toBe(false);
    // chant composes `<member>/<id>` and the member's own ids lead with its label.
    expect(body.ir.nodes.map((n) => n.id).sort()).toEqual(RESOURCES.map((id) => `app/${id}`));
    expect(body.ir.edges.length).toBeGreaterThan(0);
    expect(body.svg).toMatch(/<svg/);
    // No colour behold made up: a card is uncoloured or neutral.
    for (const n of body.ir.nodes) expect([undefined, "neutral"]).toContain(n.attrs?._status);
  });

  it.skipIf(gate)(`the overlay draws the same cards neutral, saying chant has no live read for the kind (${why})`, { timeout: 120_000 }, async () => {
    await ready;
    const res = await app!.request("http://localhost/api/overlay?env=dev");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Drawn;
    expect(body.error).toBeUndefined();
    const cards = body.ir.nodes.filter((n) => n.id.startsWith("app/"));
    expect(cards.map((n) => n.id).sort()).toEqual(RESOURCES.map((id) => `app/${id}`));
    for (const n of cards) {
      expect(n.attrs._status).toBe("neutral");
      expect(n.attrs._unobserved).toBe(PULUMI_NO_LIVE_READ);
    }
  });
});
