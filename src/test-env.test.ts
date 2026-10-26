// behold#1013: no test sees the environment of the shell that started vitest
// (src/test-env.ts, vitest.config.ts). Run it with CHOUDOUFU_BIN set to a
// real path, or after `pulumi login`, and it still passes.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { choudoufuBinary } from "./choudoufu-member.ts";
import { AMBIENT } from "./test-env.ts";

describe("the test environment (behold#1013)", () => {
  it("has none of the ambient variables behold reads, so CHOUDOUFU_BIN is the PATH default", () => {
    expect(AMBIENT.filter((name) => process.env[name] !== undefined)).toEqual([]);
    expect(choudoufuBinary()).toBe("choudoufu");
  });

  it("points pulumi and plunge at a file backend made for the run, with the update check off", () => {
    const url = process.env.PULUMI_BACKEND_URL ?? "";
    expect(url).toMatch(/^file:\/\//);
    const dir = fileURLToPath(url);
    expect(existsSync(dir)).toBe(true);
    expect(dir).toContain("behold-test-pulumi-backend-");
    expect(process.env.PULUMI_SKIP_UPDATE_CHECK).toBe("true");
    expect(process.env.PULUMI_ACCESS_TOKEN).toBeUndefined();
  });
});
