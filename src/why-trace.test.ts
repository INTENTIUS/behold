import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { setServedWorkspace, type Workspace } from "./workspace.ts";
import { CHANT_FLOORS, floorFor, floorMet } from "./chant-floors.ts";
import { whyFromIntent, withChain, WHY_TRACE_CHANT_FLOOR, type WhyAnswer } from "./workspace-why.ts";
import type { WorkspaceDocument } from "./workspace-reader.ts";
import intentSchema from "./why-trace-schema/intent.schema.json" with { type: "json" };

// #682. src/__fixtures__/why-trace/intent-node.json is what chant main at
// 5d33a48e7 (which ships chant#4023's `trace` and still calls itself
// 0.124.28; the release is 0.124.29) printed for `chant workspace graph
// --intent delivery/appService --json` in the workspace
// src/why-trace-fixture.ts makes: W-001, a base commit with no trailer and no
// tag, a commit linking W-001 and tagged green, release v1 cut from it, the
// release gate prod-release resolved by bob on the cli with a change set
// stored under its plan, a prod deploy of v1 admitted by that resolution, and
// a plain staging deploy. src/why-trace-schema/intent.schema.json is chant's
// packages/core/src/workspace/intent.schema.json from the same commit.

const FIX = join(import.meta.dirname, "__fixtures__", "why-trace");
const recorded = (): WorkspaceDocument => JSON.parse(readFileSync(join(FIX, "intent-node.json"), "utf8")) as WorkspaceDocument;
const trace = () => recorded().trace as Record<string, any>;

function answer(doc: WorkspaceDocument = recorded()): WhyAnswer {
  const read = whyFromIntent(doc);
  if (!read.ok) throw new Error(read.refusal.error);
  return read.why;
}

describe("the recorded document is chant's (#682)", () => {
  it("validates against chant's intent schema, trace and all", () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(intentSchema);
    expect(validate(recorded()), JSON.stringify(validate.errors)).toBe(true);
    expect(trace().commits).toHaveLength(2);
  });
});

describe("the why chain's floor (#682, #691)", () => {
  it("is registered as one read, 0.124.29, which degrades the pane and refuses nothing", () => {
    expect(WHY_TRACE_CHANT_FLOOR).toBe("0.124.29");
    const f = floorFor("why chain");
    expect(CHANT_FLOORS).toContain(f);
    expect(f).toMatchObject({ floor: "0.124.29", degraded: expect.stringMatching(/without the chain/) });
    expect(floorMet(f, "0.124.28")).toBe(false);
    expect(floorMet(f, "0.124.29")).toBe(true);
  });
});

describe("whyFromIntent reads the chain as chant printed it (#682)", () => {
  it("keeps each link and its source, adding only the subject and title from nodes", () => {
    const why = answer();
    const t = trace();
    expect(why.trace).not.toBeNull();
    const [linked, base] = why.trace!.commits;
    expect(linked.sha).toBe(t.commits[0].sha);
    expect(linked.subject).toBe("serve the app on 8081");
    expect(base.subject).toBe("the shop and W-001");
    expect(linked.work).toEqual({ state: "linked", items: [{ id: "work:W-001", node: "record:work/W-001", title: "Serve the app on 8081", source: { ref: linked.sha, field: "Chant-Record", value: "work:W-001" } }], problems: [] });
    expect(linked.windowMatches.map((w) => [w.id, w.source.field])).toEqual([["work:W-001", "window"]]);
    expect(linked.tag).toEqual(t.commits[0].tag);
    expect(linked.releases).toEqual(t.commits[0].releases);
    expect(linked.deploys).toEqual(t.commits[0].deploys);
    expect(base.work).toMatchObject({ state: "unlinked", items: [] });
    expect(base.tag.state).toBe("none");
    // Releases and deploys are chant's, field for field.
    expect(why.trace!.releases).toEqual(t.releases);
    expect(why.trace!.deploys).toEqual(t.deploys);
    expect(why.trace!.releases[0].gates[0]).toMatchObject({ gate: "prod-release", resolvedBy: "bob", channel: "cli", at: "2026-10-16T10:30:00.000Z", changeSet: expect.stringMatching(/^jcs1-sha256:/) });
    expect(why.trace!.reasons).toEqual([]);
  });

  it("passes chant's partial-read reasons on", () => {
    const doc = recorded();
    (doc.trace as Record<string, any>).reasons = [{ code: "ledger-unreadable", message: "delivery's ledger on chant/lifecycle: bad object" }];
    expect(answer(doc).trace!.reasons).toEqual([{ code: "ledger-unreadable", message: "delivery's ledger on chant/lifecycle: bad object" }]);
  });

  it("has no chain for a document from a chant older than 0.124.29", () => {
    const doc = recorded();
    delete doc.trace;
    expect(answer(doc).trace).toBeNull();
  });
});

describe("withChain (#682)", () => {
  it("at the floor: the chain, and says it is there", () => {
    const w = withChain(answer(), "0.124.29");
    expect(w.chain).toEqual({ full: true, floor: "0.124.29", note: null });
    expect(w.trace).not.toBeNull();
  });
  it("below the floor: today's answer, no chain, and the floor's words", () => {
    const why = answer();
    const w = withChain(why, "0.124.28");
    expect(w.trace).toBeNull();
    expect(w.chain).toEqual({ full: false, floor: "0.124.29", note: "Why chain needs chant 0.124.29 or newer. This project has chant 0.124.28." });
    expect(w.decisions).toEqual(why.decisions);
    expect(w.commits).toEqual(why.commits);
  });
  it("a chant that meets the floor by version but wrote no trace says so", () => {
    const doc = recorded();
    delete doc.trace;
    expect(withChain(answer(doc), undefined).chain).toEqual({ full: false, floor: "0.124.29", note: "chant 0.124.28 wrote no chain from work item to release; it needs chant 0.124.29 or newer." });
  });
});

// The route, through the app object, with the project's chant a shim that
// prints the recorded document: at 0.124.29 the answer carries the chain, at
// 0.124.28 the same read keeps today's view and says which chant adds it.
describe("GET /api/workspace/why carries the chain (#682)", () => {
  const made: string[] = [];
  afterAll(() => {
    setServedWorkspace(undefined);
    made.forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  function serve(version: string) {
    const root = mkdtempSync(join(tmpdir(), "behold-682-"));
    made.push(root);
    const pkg = join(root, "node_modules", "@intentius", "chant");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/chant", version, main: "index.js", bin: { chant: "bin/chant" } }));
    writeFileSync(join(pkg, "index.js"), "");
    writeFileSync(join(pkg, "bin", "chant"), `#!/bin/sh\nexec cat ${JSON.stringify(join(FIX, "intent-node.json"))}\n`);
    chmodSync(join(pkg, "bin", "chant"), 0o755);
    const w: Workspace = { name: "shop", root, file: "chant.workspace.json", chant: version, members: [{ name: "delivery", dir: "delivery", kind: "chant", abs: join(root, "delivery"), reason: null, because: null }] };
    setServedWorkspace(w);
    const broadcaster = new Broadcaster();
    return createApp({ projectDir: root, workspace: w, port: 0 }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: root, broadcaster, onDone: () => {} }));
  }

  it("at 0.124.29: the chain for a node shipped through a gate", async () => {
    const res = await serve("0.124.29").request("/api/workspace/why?node=delivery%2FappService");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.chain).toEqual({ full: true, floor: "0.124.29", note: null });
    expect(body.trace.commits[0].work.items[0]).toMatchObject({ id: "work:W-001", title: "Serve the app on 8081" });
    expect(body.trace.releases[0].gates[0]).toMatchObject({ resolvedBy: "bob", channel: "cli" });
  });

  it("at 0.124.28: decisions, runs and commits as before, and the chain's floor in words", async () => {
    const res = await serve("0.124.28").request("/api/workspace/why?node=delivery%2FappService");
    const body = (await res.json()) as Record<string, any>;
    expect(body.refusal).toBeUndefined();
    expect(body.trace).toBeNull();
    expect(body.chain).toEqual({ full: false, floor: "0.124.29", note: "Why chain needs chant 0.124.29 or newer. This project has chant 0.124.28." });
    expect(body.decisions.map((d: any) => d.id)).toEqual(["fix-001"]);
    expect(body.commits.map((c: any) => c.subject)).toContain("serve the app on 8081");
  });
});
