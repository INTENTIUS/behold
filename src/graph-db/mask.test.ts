// The row masking (src/graph-db/mask.ts): chant's lister masking (chant#4532), re-exported since behold#1005.
import * as lister from "@intentius/chant/cloud-lister/mask";
import * as chantKeys from "@intentius/chant/sensitive-key";
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

  it("is chant's list and chant's masked value", () => {
    expect(SENSITIVE_KEY_PATTERNS).toBe(chantKeys.SENSITIVE_KEY_PATTERNS);
    expect(MASKED).toBe(lister.MASKED);
    for (const k of ["password", "Secret", "apiToken", "private_key", "credentials", "ConnectionString", "Key", "KeyName"]) {
      expect(isSensitiveKey(k)).toBe(chantKeys.isSensitiveKey(k));
    }
  });
});
