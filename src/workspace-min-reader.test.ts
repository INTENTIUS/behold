// #501: a workspace whose declaration asks for minReader 0.108.0 reads.
//
// chant checks `minReader` itself, before anything else in the declaration
// (`reader-too-old`), against the chant that reads it. A root that installs no
// chant of its own is read by the one behold depends on, so that dependency's
// floor is what decides whether such a workspace reads at all: on ^0.102.0,
// terragucci's repo root (minReader 0.108.0) was refused. The directory here
// is under the system temp dir, outside behold's checkout, so it resolves no
// chant of its own and behold's is the one that reads it.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chantFloor, meetsFloor, resolveChant } from "./chant.ts";
import { readWorkspace } from "./workspace.ts";

const MIN_READER = "0.108.0";

function workspace(minReader: string): string {
  const root = mkdtempSync(join(tmpdir(), "behold-min-reader-"));
  mkdirSync(join(root, "docs"));
  writeFileSync(
    join(root, "chant.workspace.json"),
    JSON.stringify({ name: "min-reader", schema: 1, minReader, members: [{ name: "docs", dir: "docs", kind: "other", because: "prose, nothing to draw" }] }, null, 2),
  );
  return root;
}

describe("a workspace asking for minReader 0.108.0 (#501)", () => {
  it("behold's declared chant floor meets it, so the lowest chant a fresh install resolves reads it", () => {
    const floor = chantFloor();
    expect(floor).toBeDefined();
    expect(meetsFloor(floor!, MIN_READER)).toBe(true);
  });

  it("reads through behold's own chant", async () => {
    const root = workspace(MIN_READER);
    expect(resolveChant(root).source).toBe("behold");
    const read = await readWorkspace(root);
    if (!read.ok) throw new Error(`refused: ${read.refusal.code}: ${read.refusal.error}`);
    expect(read.workspace.name).toBe("min-reader");
    expect(read.workspace.members.map((m) => [m.name, m.kind])).toEqual([["docs", "other"]]);
    expect(meetsFloor(read.workspace.chant, MIN_READER)).toBe(true);
  }, 60_000);

  it("is refused as reader-too-old when it asks for a chant newer than behold's, so the read above is chant's minReader check passing", async () => {
    const read = await readWorkspace(workspace("999.0.0"));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.code).toBe("reader-too-old");
  }, 60_000);
});
