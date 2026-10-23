import { describe, expect, it } from "vitest";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { GRAPH_LINT_REPORT_CHANT_FLOOR } from "./chant-floors.ts";
import { meetsFloor } from "./floor.ts";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { HCL_PARSER_PKG, resolvedVersion, TERRAFORM_LEXICON_PKG } from "./terraform-member.ts";

// #919: a bare Terraform folder whose HCL fails one of the lexicon's error
// rules (TF033, a database stored unencrypted) is served end to end: the real
// probe, the real scratch project, the real `chant graph`. Before #919 chant's
// lint gate refused it and /api/graph answered `{"code": "lint"}`.
//
// Two gates, as src/terraform-search.test.ts has. The lexicon is an optional
// peer: skipped where it is not installed, except in CI's `peers` job
// (BEHOLD_REQUIRE_PEERS=1). And a chant below GRAPH_LINT_REPORT_CHANT_FLOOR
// ignores the scratch config's `graph.lint` and refuses, so the test waits
// for behold's chant to reach that floor.
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const FIXTURE = join(import.meta.dirname, "__fixtures__", "terraform-lint-error");
const peers = !!resolvedVersion(TERRAFORM_LEXICON_PKG) && !!resolvedVersion(HCL_PARSER_PKG);
const drawsLintErrors = meetsFloor(resolvedVersion("@intentius/chant"), GRAPH_LINT_REPORT_CHANT_FLOOR);

describe("a bare Terraform folder with an error-severity lint finding (#919)", () => {
  it.skipIf((!peers && !REQUIRE_PEERS) || !drawsLintErrors)(
    `draws, and names the finding on the card and the note (needs chant ${GRAPH_LINT_REPORT_CHANT_FLOOR})`,
    { timeout: 120_000 },
    async () => {
      const broadcaster = new Broadcaster();
      const app = createApp({ projectDir: FIXTURE, port: 0 }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: FIXTURE, broadcaster, onDone: () => {} }));
      const res = await app.request("/api/graph?detail=2");
      const body = (await res.json()) as { ir: GraphIR; meta: { note?: string; noteShort?: string }; error?: string; code?: string };
      expect(body.code, body.error).toBeUndefined();
      expect(res.status).toBe(200);
      expect(body.ir.nodes.length).toBeGreaterThan(0);
      const db = body.ir.nodes.find((n) => n.id.endsWith("aws_db_instance.orders"));
      expect(db, body.ir.nodes.map((n) => n.id).join(", ")).toBeDefined();
      expect((db!.attrs as Record<string, unknown>)._lint).toEqual([expect.objectContaining({ ruleId: "TF033" })]);
      expect(body.meta.note).toContain("1 lint error, drawn anyway — TF033 aws_db_instance.orders");
      expect(body.meta.noteShort).toContain("1 lint error");
    },
  );
});
