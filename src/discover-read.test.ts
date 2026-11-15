import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// behold#1079: a folder with no declaration is read through `chant workspace
// graph <dir> --discover` (INTENTIUS/chant#5095), from a chant at
// WORKSPACE_DISCOVER_CHANT_FLOOR. The document below was recorded from chant's
// main with that command over e2e/fixtures/discover-folder, a plain folder:
// infra/net calls ../modules/vpc, argo holds an Argo CD Application, and db is
// claimed by two sql kinds at one precedence. chant's main is not released, so
// the reads here are answered by that recording, and the floor is set by the
// resolved chant version each test names.

const FOLDER = join(import.meta.dirname, "..", "e2e", "fixtures", "discover-folder");
const RECORDED = JSON.parse(readFileSync(join(import.meta.dirname, "..", "e2e", "fixtures", "discover-folder.graph.json"), "utf8")) as Record<string, unknown>;

const state = vi.hoisted(() => ({ version: "0.124.98" as string | undefined, argv: [] as string[][] }));

vi.mock("./chant.ts", async (orig) => ({
  ...(await orig<typeof import("./chant.ts")>()),
  resolveChant: (dir?: string) => ({ source: "project", bin: "/fake/chant", root: "/fake", version: state.version, dir }),
}));
vi.mock("./workspace-reader.ts", async (orig) => {
  const real = await orig<typeof import("./workspace-reader.ts")>();
  return {
    ...real,
    rootReader: () => ({
      read: async (command: string, args: string[]) => {
        state.argv.push([command, ...args]);
        return structuredClone(RECORDED);
      },
    }),
  };
});

import { discoverApplies, discoverArgs, discoveredNote, discoverPolicy, hasKubernetesFiles, resetDiscoverCache, workspaceOfDiscovery } from "./discover-read.ts";
import { WORKSPACE_DISCOVER_CHANT_FLOOR, floorFor } from "./chant-floors.ts";
import { resetMemberIrCache } from "./member-ir.ts";
import { readGraph } from "./read-graph.ts";
import { terraformScratchDir } from "./terraform-member.ts";

const made: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "behold-1079-"));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  state.version = "0.124.98";
  state.argv = [];
  resetDiscoverCache();
  resetMemberIrCache();
});
afterEach(() => {
  delete process.env.BEHOLD_DISCOVER;
});

const TF = 'provider "aws" {\n  region = "us-east-1"\n}\n\nresource "aws_s3_bucket" "b" {\n}\n';
const DEPLOYMENT = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n";

function folder(files: Record<string, string>): string {
  const root = scratch();
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

/** Every path under `root` with its content hash: the listing a read must leave as it found it. */
function listing(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const at = rel ? `${rel}/${name}` : name;
      if (statSync(join(dir, name)).isDirectory()) {
        out.push(`d ${at}`);
        walk(join(dir, name), at);
      } else out.push(`f ${at} ${createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")}`);
    }
  };
  walk(root, "");
  return out;
}

describe("the floor", () => {
  it("names the chant release that ships --discover, 0.124.98", () => {
    expect(WORKSPACE_DISCOVER_CHANT_FLOOR).toBe("0.124.98");
    expect(floorFor("a folder with no declaration, by its kinds' probes").floor).toBe("0.124.98");
  });

  it("keeps today's read on a chant below it, and on one whose version is unknown", () => {
    const k8s = folder({ "app/deploy.yaml": DEPLOYMENT });
    state.version = "0.124.97";
    expect(discoverApplies(k8s)).toBe(false);
    state.version = "0.124.58";
    expect(discoverApplies(k8s)).toBe(false);
    state.version = undefined;
    expect(discoverApplies(k8s)).toBe(false);
    state.version = "0.124.98";
    expect(discoverApplies(k8s)).toBe(true);
    state.version = "0.125.0";
    expect(discoverApplies(k8s)).toBe(true);
  });

  it("never sends --discover to a chant below it", async () => {
    state.version = "0.124.97";
    // A Kubernetes folder no kind of behold's claims: below the floor it is read as before, which draws nothing from it.
    const r = await readGraph(folder({ "app/deploy.yaml": DEPLOYMENT })).catch(() => undefined);
    expect(r?.workspace).toBeUndefined();
    expect(state.argv).toEqual([]);
  });
});

describe("which folders are discovered (auto, always, never)", () => {
  it("reads a folder behold's readers cannot draw through chant", () => {
    expect(discoverApplies(folder({ "base/kustomization.yaml": "resources: []\n" }))).toBe(true);
    expect(discoverApplies(folder({ "charts/web/Chart.yaml": "apiVersion: v2\nname: web\nversion: 0.1.0\n" }))).toBe(true);
    expect(discoverApplies(folder({ "app/deploy.yaml": DEPLOYMENT }))).toBe(true);
  });

  it("keeps a Terraform folder on behold's own reader, which is the faster read", () => {
    expect(discoverApplies(folder({ "net/main.tf": TF, "iam/main.tf": TF }))).toBe(false);
  });

  it("reads a folder that holds both through chant, so the Kubernetes half is drawn", () => {
    expect(discoverApplies(folder({ "net/main.tf": TF, "app/deploy.yaml": DEPLOYMENT }))).toBe(true);
  });

  it("never discovers a chant project or a folder with a declaration", () => {
    expect(discoverApplies(folder({ "chant.config.ts": "export default {};\n", "k/deploy.yaml": DEPLOYMENT }))).toBe(false);
    expect(discoverApplies(folder({ "chant.workspace.json": "{}\n", "k/deploy.yaml": DEPLOYMENT }))).toBe(false);
    process.env.BEHOLD_DISCOVER = "always";
    expect(discoverApplies(folder({ "chant.config.ts": "export default {};\n", "k/deploy.yaml": DEPLOYMENT }))).toBe(false);
  });

  it("answers to BEHOLD_DISCOVER", () => {
    const tf = folder({ "net/main.tf": TF });
    const k8s = folder({ "app/deploy.yaml": DEPLOYMENT });
    expect(discoverPolicy({})).toBe("auto");
    expect(discoverPolicy({ BEHOLD_DISCOVER: "ALWAYS" })).toBe("always");
    expect(discoverPolicy({ BEHOLD_DISCOVER: "nonsense" })).toBe("auto");
    expect(discoverApplies(tf, { BEHOLD_DISCOVER: "always" })).toBe(true);
    expect(discoverApplies(k8s, { BEHOLD_DISCOVER: "never" })).toBe(false);
  });

  it("leaves example-terraform-estate on its own reader, copied without its declaration", () => {
    const copy = scratch();
    cpSync(join(import.meta.dirname, "..", "example-terraform-estate"), copy, { recursive: true, filter: (src) => !src.endsWith("chant.workspace.json") });
    expect(discoverApplies(copy)).toBe(false);
  });

  it("finds Kubernetes files by name and by their top-level apiVersion and kind", () => {
    expect(hasKubernetesFiles(folder({ "a/values.yaml": "replicas: 2\n" }))).toBe(false);
    expect(hasKubernetesFiles(folder({ "a/ci.yml": "name: ci\non: push\n" }))).toBe(false);
    expect(hasKubernetesFiles(folder({ "node_modules/x/deploy.yaml": DEPLOYMENT }))).toBe(false);
    expect(hasKubernetesFiles(folder({ ".git/deploy.yaml": DEPLOYMENT }))).toBe(false);
    expect(hasKubernetesFiles(folder({ "a/b/c/deploy.yaml": DEPLOYMENT }))).toBe(true);
  });
});

describe("the discovery document", () => {
  it("asks for the folder, --discover and the detail tier, and no --member", () => {
    expect(discoverArgs("/x", { detail: 2 })).toEqual(["/x", "--discover", "--detail", "2"]);
    expect(discoverArgs("/x", { env: "prod", live: true })).toEqual(["/x", "--discover", "--env", "prod", "--live"]);
  });

  it("becomes a workspace of its members, with chant's discovered list", () => {
    const ws = workspaceOfDiscovery(FOLDER, RECORDED);
    expect(ws.file).toBe("");
    expect(ws.members.map((m) => [m.name, m.dir, m.kind, m.reason])).toEqual([
      ["argo", "argo", "argo-app", null],
      ["infra-net", "infra/net", "terraform", null],
    ]);
    expect(ws.members[1].abs).toBe(join(FOLDER, "infra/net"));
    expect(ws.discovered?.map((d) => [d.dir, d.outcome, d.member])).toEqual([
      ["argo", "member", "argo"],
      ["db", "tie", null],
      ["infra/modules/vpc", "module", null],
      ["infra/net", "member", "infra-net"],
    ]);
  });

  it("says a tie is not read, and how many directories were left out", () => {
    const note = discoveredNote(workspaceOfDiscovery(FOLDER, RECORDED).discovered!);
    expect(note.note).toBe(
      "1 directory is claimed by two kinds and not read: db (flyway, golang-migrate, clickhouse-migrations); name the kind in a chant.workspace.json to read it; 1 directory is left out as a module a member calls or inside another member",
    );
    expect(note.noteShort).toBe("1 tied · 1 left out");
    expect(discoveredNote([])).toEqual({});
  });

  it("carries a member chant could not read as its reason, to be drawn as an unreadable box", () => {
    const doc = structuredClone(RECORDED) as { members: { status: string; reason?: unknown }[] };
    doc.members[0].status = "failed";
    doc.members[0].reason = { code: "command-failed", message: "no kustomize" };
    const ws = workspaceOfDiscovery(FOLDER, doc);
    expect(ws.members[0].reason).toEqual({ code: "command-failed", message: "no kustomize" });
  });
});

describe("readGraph over a folder chant discovers (behold#1079)", () => {
  it("draws infra/net and argo, nothing from the module, in one chant call, and writes nothing", async () => {
    // A copy, so the scratch name behold would give it is this test's alone.
    const copy = scratch();
    cpSync(FOLDER, copy, { recursive: true });
    const before = listing(copy);
    const r = await readGraph(copy, { detail: 2 });
    expect(state.argv).toEqual([["graph", copy, "--discover", "--detail", "2"]]);
    expect(r.members.map((m) => [m.name, m.kind])).toEqual([
      ["argo", "argo-app"],
      ["infra-net", "terraform"],
    ]);
    expect(r.workspace?.discovered).toHaveLength(4);
    const ids = r.ir.nodes.map((n) => n.id);
    expect(ids.some((id) => id.startsWith("argo/"))).toBe(true);
    expect(ids.some((id) => id.startsWith("infra-net/"))).toBe(true);
    // The module's resource is read with the root that calls it, as a node of infra-net, and no member of its own.
    expect(ids.some((id) => id.includes("module.vpc/aws_vpc.main"))).toBe(true);
    expect(ids.every((id) => id.startsWith("argo/") || id.startsWith("infra-net/"))).toBe(true);
    expect(r.meta.estate).toBe(2);
    expect(r.meta.note).toContain("claimed by two kinds and not read: db");
    // A read that writes no scratch project: the folder is as it was, and no behold-tf-* appeared beside it.
    expect(listing(copy)).toEqual(before);
    expect(existsSync(terraformScratchDir(copy))).toBe(false);
  });

  it("answers a list of one path as the folder itself, which is how the server hands it over", async () => {
    const r = await readGraph([FOLDER], { detail: 2 });
    expect(r.members.map((m) => m.name)).toEqual(["argo", "infra-net"]);
  });

  it("serves the same document to every member from one chant call, and from the cache on a reread", async () => {
    await readGraph(FOLDER, { detail: 2 });
    await readGraph(FOLDER, { detail: 2 });
    expect(state.argv).toHaveLength(1);
  });

  it("reads a folder as before when BEHOLD_DISCOVER is never", async () => {
    process.env.BEHOLD_DISCOVER = "never";
    // behold's own reader: one member, named for the folder, and no --discover sent.
    await readGraph(FOLDER, { detail: 2 }).catch(() => undefined);
    expect(state.argv).toEqual([]);
  });
});
