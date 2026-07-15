import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseEmulators, mergedEnv, dockerHint, emulatorUp, emulatorDown } from "./emulator.ts";
import { runChantRaw } from "./chant.ts";

vi.mock("./chant.ts", () => ({ runChantRaw: vi.fn() }));

const FLOCI = {
  lexicon: "aws",
  name: "chant-floci",
  endpoint: "http://localhost:4566",
  env: { AWS_ENDPOINT_URL: "http://localhost:4566", AWS_REGION: "us-east-1" },
};

describe("parseEmulators", () => {
  it("reads the { emulators: [...] } envelope", () => {
    expect(parseEmulators(JSON.stringify({ emulators: [FLOCI] }))).toEqual([FLOCI]);
  });
  it("finds the JSON line after `up`'s progress output on stdout", () => {
    const stdout =
      `emulator container "chant-floci" already running — reusing\n` +
      `emulator "chant-floci" ready on http://localhost:4566\n` +
      JSON.stringify({ emulators: [FLOCI] }) + "\n";
    expect(parseEmulators(stdout)).toEqual([FLOCI]);
  });
  it("returns [] for an empty result or malformed output", () => {
    expect(parseEmulators(JSON.stringify({ emulators: [] }))).toEqual([]);
    expect(parseEmulators("{}")).toEqual([]);
    expect(parseEmulators("not json")).toEqual([]);
    expect(parseEmulators("emulator booting…\nstill going")).toEqual([]);
  });
});

describe("mergedEnv", () => {
  it("merges every emulator's redirect env into one map", () => {
    const gcp = { lexicon: "gcp", name: "chant-floci-gcp", endpoint: "http://localhost:8085", env: { STORAGE_EMULATOR_HOST: "localhost:8085" } };
    expect(mergedEnv([FLOCI, gcp])).toEqual({
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AWS_REGION: "us-east-1",
      STORAGE_EMULATOR_HOST: "localhost:8085",
    });
  });
  it("is empty for no emulators", () => {
    expect(mergedEnv([])).toEqual({});
  });
});

describe("dockerHint", () => {
  it("flags a Docker-shaped failure", () => {
    expect(dockerHint("Cannot connect to the Docker daemon")).toMatch(/needs Docker/);
    expect(dockerHint("spawn docker ENOENT")).toMatch(/needs Docker/);
    expect(dockerHint("docker: command not found")).toMatch(/needs Docker/);
  });
  it("leaves an unrelated failure alone", () => {
    expect(dockerHint("some chant build error")).toBeUndefined();
  });
});

describe("emulatorUp / emulatorDown", () => {
  beforeEach(() => vi.mocked(runChantRaw).mockReset());

  it("boots via `chant emulator up --json` and returns the parsed emulators", async () => {
    vi.mocked(runChantRaw).mockResolvedValue({ code: 0, stdout: JSON.stringify({ emulators: [FLOCI] }), stderr: "" });
    const got = await emulatorUp("/proj");
    expect(got).toEqual([FLOCI]);
    expect(runChantRaw).toHaveBeenCalledWith(["emulator", "up", "--json"], "/proj");
  });

  it("returns [] when the project has no emulator-backed lexicon", async () => {
    vi.mocked(runChantRaw).mockResolvedValue({ code: 0, stdout: JSON.stringify({ emulators: [] }), stderr: "" });
    expect(await emulatorUp("/proj")).toEqual([]);
  });

  it("throws a clear Docker message when the daemon is down", async () => {
    vi.mocked(runChantRaw).mockResolvedValue({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" });
    await expect(emulatorUp("/proj")).rejects.toThrow(/needs Docker/);
  });

  it("surfaces a non-Docker failure verbatim", async () => {
    vi.mocked(runChantRaw).mockResolvedValue({ code: 2, stdout: "", stderr: "boom" });
    await expect(emulatorUp("/proj")).rejects.toThrow(/exit 2.*boom/s);
  });

  it("tears down via `chant emulator down`", async () => {
    vi.mocked(runChantRaw).mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    await emulatorDown("/proj");
    expect(runChantRaw).toHaveBeenCalledWith(["emulator", "down"], "/proj");
  });
});
