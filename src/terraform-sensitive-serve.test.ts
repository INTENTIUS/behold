import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { GRAPH_LINT_REPORT_CHANT_FLOOR } from "./chant-floors.ts";
import { meetsFloor } from "./floor.ts";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { runExport } from "./export.ts";
import { HCL_PARSER_PKG, resolvedVersion, TERRAFORM_LEXICON_PKG } from "./terraform-member.ts";

// #920: a root with `sensitive = true` variables whose defaults are a string, a
// number and a map is served end to end (real probe, real scratch project, real
// `chant graph`), and none of the three values is in /api/graph at any zoom or
// in an export. The lexicon is an optional peer: skipped where it is not
// installed, except in CI's `peers` job (BEHOLD_REQUIRE_PEERS=1).
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const FIXTURE = join(import.meta.dirname, "__fixtures__", "terraform-sensitive-default");
const peers = !!resolvedVersion(TERRAFORM_LEXICON_PKG) && !!resolvedVersion(HCL_PARSER_PKG);
// A sensitive variable with a default is itself a lint error (TF006), so the
// root is drawn only by a chant that draws lint errors (#919).
const drawsLintErrors = meetsFloor(resolvedVersion("@intentius/chant"), GRAPH_LINT_REPORT_CHANT_FLOOR);
const SECRETS = ["tok-hunter2-string", "4815162342", "admin-sekrit-user", "pass-sekrit-map"];

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
}

describe("a sensitive variable's literal default (#920)", () => {
  it.skipIf((!peers && !REQUIRE_PEERS) || !drawsLintErrors)("is in no /api/graph response and no export", { timeout: 180_000 }, async () => {
    const broadcaster = new Broadcaster();
    const app = createApp({ projectDir: FIXTURE, port: 0 }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: FIXTURE, broadcaster, onDone: () => {} }));
    for (const detail of ["1", "2", "3"]) {
      const res = await app.request(`/api/graph?detail=${detail}`);
      const text = await res.text();
      const body = JSON.parse(text) as { ir: GraphIR; error?: string };
      expect(res.status, body.error).toBe(200);
      expect(body.ir.nodes.length).toBeGreaterThan(0);
      for (const s of SECRETS) expect(text, `detail ${detail}`).not.toContain(s);
    }
    // What the inspect pane shows for a block's source is still the file, with the value replaced.
    const body = (await (await app.request("/api/graph?detail=3")).json()) as { ir: GraphIR };
    const queue = body.ir.nodes.find((n) => n.id.endsWith("aws_sqs_queue.jobs"));
    const source = (queue!.attrs as Record<string, string>).source;
    expect(source).toContain('resource "aws_sqs_queue" "jobs"');
    expect(source).toContain("default   = (sensitive)");
    expect(source).toContain('default = "us-east-1"');

    const out = mkdtempSync(join(tmpdir(), "behold-920-"));
    made.push(out);
    await runExport({ projectDir: FIXTURE, port: 0 }, out);
    const all = files(out);
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) {
      const text = readFileSync(f, "utf8");
      for (const s of SECRETS) expect(text.includes(s), `${s} in ${f}`).toBe(false);
    }
  });
});
