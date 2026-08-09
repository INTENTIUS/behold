// #195: the project switcher's memory — a validated, deduped, capped recents
// file. BEHOLD_RECENTS_FILE points it at a temp file here so tests never
// touch the real ~/.behold/recents.json.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecents, addRecent } from "./recents.ts";

describe("recents (#195)", () => {
  let dir: string;
  let projA: string;
  let projB: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "behold-recents-"));
    process.env.BEHOLD_RECENTS_FILE = join(dir, "recents.json");
    projA = join(dir, "a");
    mkdirSync(projA);
    writeFileSync(join(projA, "chant.config.ts"), "export default {};");
    projB = join(dir, "b");
    mkdirSync(projB);
    writeFileSync(join(projB, "chant.config.ts"), "export default {};");
  });
  afterEach(() => {
    delete process.env.BEHOLD_RECENTS_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty; add + list round-trips, most recent first", () => {
    expect(listRecents()).toEqual([]);
    addRecent(projA, () => "t1");
    addRecent(projB, () => "t2");
    expect(listRecents().map((r) => r.dir)).toEqual([projB, projA]);
  });

  it("re-adding an existing dir moves it to the front instead of duplicating", () => {
    addRecent(projA);
    addRecent(projB);
    addRecent(projA);
    expect(listRecents().map((r) => r.dir)).toEqual([projA, projB]);
  });

  it("a dir that stopped being a chant project drops out on read — no dead switch targets", () => {
    addRecent(projA);
    addRecent(projB);
    rmSync(join(projA, "chant.config.ts"));
    expect(listRecents().map((r) => r.dir)).toEqual([projB]);
  });

  it("a corrupt recents file reads as empty, never a throw", () => {
    writeFileSync(process.env.BEHOLD_RECENTS_FILE!, "not json{");
    expect(listRecents()).toEqual([]);
  });
});
