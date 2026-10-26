import { describe, it, expect, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRIFT_RECORD_CHANT_FLOOR } from "./chant-floors.ts";
import { linkDemoPins } from "./demo-pins.ts";
import { meetsFloor } from "./floor.ts";
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
  servedWorkspace,
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
//    8cd73461a. The declaration pins the pulumi lexicon at the published chant
//    while CHANT_RELEASE is unreleased (src/chant-release.ts, behold#1015);
//    it was 0.124.34 when the graph below was recorded.
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

// The e2e: the fixture served the way `behold serve <workspace>` serves it,
// through the real chant installed beside behold. chant reads the kinds of a
// pinned package only at the version the pin names, and the fixture pins the
// published chant (behold#1015), which has no pulumi lexicon; the one beside
// behold is a local build of chant stamped at CHANT_RELEASE. So the test
// serves a copy of the fixture under the OS temp directory, re-pinned at the
// installed lexicon and linked to it the way a demo copy is (src/demo-pins.ts),
// and the gate is that a pulumi lexicon is installed at all. Nothing is
// written under the fixture.
const PULUMI_LEXICON_PKG = "@intentius/chant-lexicon-pulumi";
const INSTALLED = resolvedVersion(PULUMI_LEXICON_PKG);
const gate = !INSTALLED && !REQUIRE_PEERS;
const why = `needs ${PULUMI_LEXICON_PKG} (INTENTIUS/chant#4453) installed beside behold, a local build of chant until CHANT_RELEASE is released`;
const COPY = gate ? "" : mkdtempSync(join(tmpdir(), "behold-pulumi-workspace-"));
afterAll(() => {
  if (COPY) rmSync(COPY, { recursive: true, force: true });
});

interface Drawn {
  error?: string;
  svg?: string;
  ir: { nodes: Array<{ id: string; kind: string; attrs: Record<string, unknown> }>; edges: unknown[] };
}

describe("a pulumi member in a chant workspace renders, through the real chant (behold#994)", () => {
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

  // behold#995: on a chant at DRIFT_RECORD_CHANT_FLOOR the overlay paints a pulumi member from
  // `chant workspace drift --member app`, which runs `pulumi refresh --preview-only` once per
  // resource in the export. The fixture selects no stack, so every record is not-observed with
  // pulumi's reason. The backend is pointed at an empty local directory so that refresh can never
  // reach Pulumi Cloud or a backend the machine is logged in to. On an older chant there is no
  // drift read, and the card says behold's own words for why nothing was observed.
  it.skipIf(gate)(`the overlay draws the same cards neutral, each saying why nothing was observed (${why})`, { timeout: 120_000 }, async () => {
    await ready;
    const backend = mkdtempSync(join(tmpdir(), "behold-pulumi-backend-"));
    const was = { url: process.env.PULUMI_BACKEND_URL, check: process.env.PULUMI_SKIP_UPDATE_CHECK };
    process.env.PULUMI_BACKEND_URL = `file://${backend}`;
    process.env.PULUMI_SKIP_UPDATE_CHECK = "true";
    try {
      const res = await app!.request("http://localhost/api/overlay?env=dev");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Drawn;
      expect(body.error).toBeUndefined();
      const cards = body.ir.nodes.filter((n) => n.id.startsWith("app/"));
      expect(cards.map((n) => n.id).sort()).toEqual(RESOURCES.map((id) => `app/${id}`));
      const record = meetsFloor(servedWorkspace()?.chant, DRIFT_RECORD_CHANT_FLOOR);
      for (const n of cards) {
        expect(n.attrs._status).toBe("neutral");
        if (record) {
          expect((n.attrs._drift as { status?: string } | undefined)?.status).toBe("not-observed");
          expect(n.attrs._unobserved).toEqual(expect.any(String));
          expect(n.attrs._unobserved).not.toBe("");
        } else expect(n.attrs._unobserved).toBe(PULUMI_NO_LIVE_READ);
      }
    } finally {
      for (const [k, v] of [["PULUMI_BACKEND_URL", was.url], ["PULUMI_SKIP_UPDATE_CHECK", was.check]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(backend, { recursive: true, force: true });
    }
  });
});
