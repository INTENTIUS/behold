// The row masking (src/graph-db/mask.ts), kept when the lister moved to chant (chant#4532).
import { describe, expect, it } from "vitest";
import { isSensitiveKey, MASKED, maskValue, SENSITIVE_KEY_PATTERNS } from "./mask.ts";

describe("row masking", () => {
  it("masks values under sensitive keys and in key/value pairs", () => {
    expect(
      maskValue({
        Name: "db",
        MasterUserPassword: "hunter2",
        Nested: { list: [{ clientSecret: "s" }, { ok: 1 }] },
        Tags: [{ Key: "github-token", Value: "ghp_x" }, { Key: "env", Value: "prod" }],
        KeyName: "deploy-key",
      }),
    ).toEqual({
      Name: "db",
      MasterUserPassword: MASKED,
      Nested: { list: [{ clientSecret: MASKED }, { ok: 1 }] },
      Tags: [{ Key: "github-token", Value: MASKED }, { Key: "env", Value: "prod" }],
      KeyName: "deploy-key",
    });
  });

  it("uses chant's key list when the installed chant exports it", async () => {
    const specifier = "@intentius/chant/sensitive-key";
    let chant: { SENSITIVE_KEY_PATTERNS?: readonly RegExp[]; isSensitiveKey?: (k: string) => boolean } | undefined;
    try {
      chant = await import(/* @vite-ignore */ specifier);
    } catch {
      chant = undefined;
    }
    if (!chant?.SENSITIVE_KEY_PATTERNS) return; // published chant 0.124.52 has no such module yet
    expect(SENSITIVE_KEY_PATTERNS.map(String)).toEqual(chant.SENSITIVE_KEY_PATTERNS.map(String));
    for (const k of ["password", "Secret", "apiToken", "private_key", "credentials", "ConnectionString", "Key", "KeyName"]) {
      expect(isSensitiveKey(k)).toBe(chant.isSensitiveKey!(k));
    }
  });

  it("writes the masked value chant's lister writes", async () => {
    const specifier = "@intentius/chant/cloud-lister/mask";
    let lister: { MASKED?: string } | undefined;
    try {
      lister = await import(/* @vite-ignore */ specifier);
    } catch {
      lister = undefined;
    }
    if (lister?.MASKED === undefined) return; // no chant with chant#4532 beside behold
    expect(MASKED).toBe(lister.MASKED);
  });
});
