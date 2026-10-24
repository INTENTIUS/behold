import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutKey } from "./layout.ts";
import { readUserSettings, settingsPath, writeUserSettings } from "./user-settings.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "behold-settings-test-"));
  made.push(d);
  return d;
};

describe("per-user settings (#470)", () => {
  it("live in the cache, keyed like the layout, outside the project", () => {
    const project = scratch();
    const cache = scratch();
    expect(settingsPath(project, cache)).toBe(join(cache, "settings", `${layoutKey(project)}.json`));
    const file = writeUserSettings(project, { behaviour: { traffic: "100 rps" } }, cache);
    expect(readdirSync(project)).toEqual([]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readUserSettings(project, cache)).toEqual({ behaviour: { traffic: "100 rps" } });
  });

  it("read a pre-#470 .behold.json's approver and behaviour once, and never write or delete it", () => {
    const project = scratch();
    const cache = scratch();
    const text = JSON.stringify({
      members: ["a"],
      tiers: { envVar: "T", values: ["x"] },
      approver: { as: " github:alice ", signingKey: "keys/alice", keys: { "github:bob": "/abs/bob", "github:carol": "  " }, header: "X-User" },
      behaviour: { traffic: " 100 rps, p50 " },
    });
    writeFileSync(join(project, ".behold.json"), text);
    const want = {
      approver: { as: "github:alice", signingKey: join(project, "keys/alice"), keys: { "github:bob": "/abs/bob" }, header: "X-User" },
      behaviour: { traffic: "100 rps, p50" },
    };
    expect(readUserSettings(project, cache)).toEqual(want);
    expect(existsSync(settingsPath(project, cache))).toBe(true);
    // After the first read only the cache is read.
    writeFileSync(join(project, ".behold.json"), JSON.stringify({ behaviour: { traffic: "9 rps" } }));
    expect(readUserSettings(project, cache)).toEqual(want);
    expect(readFileSync(join(project, ".behold.json"), "utf8")).toBe(JSON.stringify({ behaviour: { traffic: "9 rps" } }));
    expect(readdirSync(project)).toEqual([".behold.json"]);
  });

  it("record a .behold.json with neither block as read, so it is not read again", () => {
    const project = scratch();
    const cache = scratch();
    writeFileSync(join(project, ".behold.json"), JSON.stringify({ members: ["a"] }));
    expect(readUserSettings(project, cache)).toEqual({});
    expect(existsSync(settingsPath(project, cache))).toBe(true);
    writeFileSync(join(project, ".behold.json"), JSON.stringify({ behaviour: { traffic: "9 rps" } }));
    expect(readUserSettings(project, cache)).toEqual({});
  });

  it("write nothing for a project with no .behold.json, and read wrong-typed or unparseable values as nothing", () => {
    const project = scratch();
    const cache = scratch();
    expect(readUserSettings(project, cache)).toEqual({});
    expect(existsSync(settingsPath(project, cache))).toBe(false);
    writeUserSettings(project, {}, cache);
    writeFileSync(settingsPath(project, cache), JSON.stringify({ approver: { as: 7 }, behaviour: { traffic: "  " } }));
    expect(readUserSettings(project, cache)).toEqual({});
    writeFileSync(settingsPath(project, cache), "{ nope");
    expect(readUserSettings(project, cache)).toEqual({});
  });
});
