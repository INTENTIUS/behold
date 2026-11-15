import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.ts";
import { localServeOptions } from "./shot-cli.ts";
import { HCL_PARSER_PKG, resolvedVersion, TERRAFORM_LEXICON_PKG } from "./terraform-member.ts";

// behold#1057: /api/graph over a Terraform estate, byte for byte, through the
// real chant. The estate branch reads through `readGraph` (src/read-graph.ts),
// and these goldens were written by the route as it was before that module
// existed, so a difference here is a change in what the route answers.
//
// Two shapes: example-terraform-estate as it is checked in (a declared chant
// workspace of two terraform members), and the same files with the
// declaration removed (a bare folder of .tf files, read as a one-member
// estate). The served directory is replaced by `<dir>` so the goldens do not
// carry this checkout's path. Each answer is pinned by the sha256 of its whole
// body, svg included, with its counts and note beside it so a reader of a
// changed golden can see what moved. A chant, lexicon or pinhole upgrade that
// changes the picture rewrites them with `npx vitest run -u` on this file.

const HERE = dirname(fileURLToPath(import.meta.url));
const ESTATE = join(HERE, "..", "example-terraform-estate");
const GOLDEN = join(HERE, "__fixtures__", "read-graph");

interface Answer {
  status: number;
  sha256: string;
  nodes: number;
  edges: number;
  note?: string;
}
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const peers = !!resolvedVersion(TERRAFORM_LEXICON_PKG) && !!resolvedVersion(HCL_PARSER_PKG);
const gate = !peers && !REQUIRE_PEERS;

const QUERIES: Record<string, string> = {
  resources: "",
  attributes: "?detail=3",
  "every-card": "?alike=0",
  collapsed: "?collapse=1",
  logical: "?logical=1",
};

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

async function answers(dir: string): Promise<string> {
  const app = createApp(await localServeOptions(dir));
  const out: Record<string, Answer> = {};
  for (const [name, q] of Object.entries(QUERIES)) {
    const res = await app.request(`http://localhost/api/graph${q}`);
    const text = (await res.text()).split(dir).join("<dir>");
    const body = JSON.parse(text) as { ir: { nodes: unknown[]; edges: unknown[] }; meta: { note?: string } };
    out[name] = {
      status: res.status,
      sha256: createHash("sha256").update(text).digest("hex"),
      nodes: body.ir.nodes.length,
      edges: body.ir.edges.length,
      ...(body.meta.note ? { note: body.meta.note } : {}),
    };
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

describe("/api/graph over Terraform, before and after readGraph (#1057)", () => {
  it.skipIf(gate)("example-terraform-estate, a declared workspace", { timeout: 240_000 }, async () => {
    await expect(await answers(ESTATE)).toMatchFileSnapshot(join(GOLDEN, "workspace.json"));
  });

  it.skipIf(gate)("a bare folder of .tf files", { timeout: 240_000 }, async () => {
    const parent = mkdtempSync(join(tmpdir(), "behold-1057-"));
    made.push(parent);
    // A name chant's declaration accepts, since the folder's member is named after it (#925).
    const dir = join(parent, "bare-estate");
    cpSync(ESTATE, dir, { recursive: true });
    rmSync(join(dir, "chant.workspace.json"));
    await expect(await answers(dir)).toMatchFileSnapshot(join(GOLDEN, "bare.json"));
  });
});
