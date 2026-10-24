import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseForgeIdentity } from "@intentius/chant/workspace/identity";
import {
  approverFlags,
  approverFor,
  approverFromSettings,
  approverOptionsProblem,
  approverView,
  isForgeIdentity,
  resolveApproverOptions,
  type ApproverOptions,
} from "./approver.ts";
import { writeUserSettings } from "./user-settings.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "behold-approver-test-"));
  made.push(d);
  return d;
};

const headers = (h: Record<string, string>) => (name: string) => h[name];

describe("isForgeIdentity (#690)", () => {
  it("reads a principal exactly as chant's parseForgeIdentity does", () => {
    const cases = [
      "github:alice", "GitHub:Alice", "gitlab:a.b_c", "forgejo@codeberg.org:bob", "github@ghe.example.com:carol",
      "forgejo:bob", "gitea:x", "alice", "alice@example.com", "github:", "bitbucket:alice", " github:alice ",
      "github:-alice", "github:alice-", "github:a", "gitlab@gitlab.example:z_",
    ];
    for (const p of cases) expect([p, isForgeIdentity(p)]).toEqual([p, parseForgeIdentity(p) !== null]);
  });
});

describe("approverFor (#690)", () => {
  it("falls back to chant's own fallback, and passes no --actor for it", () => {
    const read = approverFor({}, headers({}), { USER: "alex" });
    expect(read).toEqual({ ok: true, approver: { principal: "alex", source: "process", forge: false, key: null } });
    if (read.ok) expect(approverFlags(read.approver)).toEqual(["--note", "approved in behold"]);
  });

  it("names the person --as gives, with their key for a signed gate only", () => {
    const o: ApproverOptions = { as: "github:alice", signingKey: "/keys/alice" };
    const read = approverFor(o, headers({}), {});
    expect(read).toEqual({ ok: true, approver: { principal: "github:alice", source: "configured", forge: true, key: "/keys/alice" } });
    if (!read.ok) return;
    expect(approverFlags(read.approver)).toEqual(["--actor", "github:alice", "--note", "approved in behold"]);
    expect(approverFlags(read.approver, { sign: true })).toEqual(["--actor", "github:alice", "--note", "approved in behold", "--sign", "/keys/alice"]);
    expect(approverView(read.approver)).toEqual({ principal: "github:alice", source: "configured", forge: true, signs: true });
  });

  it("reads the trusted header, a bare login as an account on the configured forge", () => {
    const o: ApproverOptions = { header: "x-forwarded-user", keys: { "github:alice": "/keys/alice" } };
    expect(approverFor(o, headers({ "x-forwarded-user": "Alice" }))).toMatchObject({ ok: true, approver: { principal: "github:Alice", source: "header", key: "/keys/alice" } });
    expect(approverFor(o, headers({ "x-forwarded-user": "github:bob" }))).toMatchObject({ ok: true, approver: { principal: "github:bob", key: null } });
    expect(approverFor({ ...o, headerForge: "forgejo@codeberg.org" }, headers({ "x-forwarded-user": "bob" }))).toMatchObject({ ok: true, approver: { principal: "forgejo@codeberg.org:bob" } });
  });

  it("refuses a request with no trusted header, or one that names no forge login", () => {
    const o: ApproverOptions = { header: "x-forwarded-user" };
    expect(approverFor(o, headers({}))).toMatchObject({ ok: false, refusal: { code: "no-identity" } });
    expect(approverFor(o, headers({ "x-forwarded-user": "alice@example.com" }))).toMatchObject({ ok: false, refusal: { code: "identity-header" } });
    expect(approverFor(o, headers({ "x-forwarded-user": "--sign" }))).toMatchObject({ ok: false, refusal: { code: "identity-header" } });
  });

  it("refuses a proxy identity header behold was not told to trust, even beside --as", () => {
    for (const o of [{}, { as: "github:alice" }]) {
      const read = approverFor(o, headers({ "x-forwarded-user": "mallory" }), { USER: "alex" });
      expect(read).toMatchObject({ ok: false, refusal: { code: "identity-header" } });
    }
  });
});

describe("approverOptionsProblem (#690)", () => {
  it("takes a plain setup", () => {
    expect(approverOptionsProblem({})).toBeNull();
    expect(approverOptionsProblem({ as: "github:alice" })).toBeNull();
    expect(approverOptionsProblem({ header: "x-forwarded-user" }, "127.0.0.1")).toBeNull();
  });
  it("refuses a trusted header on an address anyone can reach", () => {
    expect(approverOptionsProblem({ header: "x-forwarded-user" }, "0.0.0.0")).toMatch(/127\.0\.0\.1/);
  });
  it("refuses a key with no person, a missing key file, and two sources of the person", () => {
    expect(approverOptionsProblem({ signingKey: "/k" })).toMatch(/needs --as/);
    expect(approverOptionsProblem({ as: "github:alice", signingKey: "/nowhere/key" })).toMatch(/not at \/nowhere\/key/);
    expect(approverOptionsProblem({ as: "github:alice", header: "x-forwarded-user" })).toMatch(/use one/);
    expect(approverOptionsProblem({ as: "-x" })).toMatch(/dash/);
    expect(approverOptionsProblem({ header: "x-forwarded-user", headerForge: "bitbucket" })).toMatch(/--identity-forge/);
  });
});

describe("the approver settings (#690, #470)", () => {
  it("are read from the per-user settings, key paths resolved against the project, under the flags and the environment", () => {
    const dir = scratch();
    const cache = scratch();
    writeUserSettings(dir, { approver: { as: "github:alice", signingKey: "alice", keys: { "github:bob": "keys/bob" } } }, cache);
    expect(approverFromSettings(dir, cache)).toEqual({ as: "github:alice", signingKey: join(dir, "alice"), keys: { "github:bob": join(dir, "keys/bob") } });
  });
  it("migrate a pre-#470 .behold.json block once, leaving the file as it was", () => {
    const dir = scratch();
    writeFileSync(join(dir, "alice"), "");
    const text = JSON.stringify({ approver: { as: "github:alice", signingKey: "alice", keys: { "github:bob": "keys/bob" } } });
    writeFileSync(join(dir, ".behold.json"), text);
    expect(approverFromSettings(dir)).toEqual({ as: "github:alice", signingKey: join(dir, "alice"), keys: { "github:bob": join(dir, "keys/bob") } });
    expect(resolveApproverOptions({}, dir, {})).toMatchObject({ as: "github:alice", signingKey: join(dir, "alice") });
    expect(resolveApproverOptions({}, dir, { BEHOLD_APPROVER: "github:carol" }).as).toBe("github:carol");
    expect(resolveApproverOptions({ as: "github:dana" }, dir, { BEHOLD_APPROVER: "github:carol" }).as).toBe("github:dana");
    expect(resolveApproverOptions({ header: "X-Forwarded-User" }, dir, {}).header).toBe("x-forwarded-user");
    // Read once: an edit to .behold.json after the first read is not picked up.
    writeFileSync(join(dir, ".behold.json"), JSON.stringify({ approver: { as: "github:eve" } }));
    expect(approverFromSettings(dir).as).toBe("github:alice");
    expect(readFileSync(join(dir, ".behold.json"), "utf8")).toBe(JSON.stringify({ approver: { as: "github:eve" } }));
  });
  it("are nothing when there is no block", () => {
    expect(approverFromSettings(scratch())).toEqual({});
  });
});
