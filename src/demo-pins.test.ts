import { describe, it, expect, afterAll } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkDemoPins } from "./demo-pins.ts";
import { resolvedPackage, type TerraformReaderState } from "./terraform-member.ts";
import { loadDemo, loadDemoRegistry } from "./demos.ts";
import { readWorkspace } from "./workspace.ts";

// CI's `peers` job sets BEHOLD_REQUIRE_PEERS=1 (scripts/install-peers.sh): there a
// missing peer fails the test instead of skipping it.
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";

const LEXICON = "@intentius/chant-lexicon-terraform";
const REPO = join(import.meta.dirname, "..");
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "behold-demo-pins-"));
  made.push(d);
  return d;
};

/** A demo copy with a declaration pinning `pins`, and a package directory behold "resolves". */
function copy(pins: { package: string; version: string }[]): { work: string; pkgDir: string } {
  const work = scratch();
  writeFileSync(join(work, "chant.workspace.json"), JSON.stringify({ name: "demo", schema: 1, pins, members: [] }, null, 2) + "\n");
  const pkgDir = join(scratch(), "node_modules", LEXICON);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: LEXICON, version: "0.102.0" }));
  return { work, pkgDir };
}

const readable: () => TerraformReaderState = () => ({ lexicon: { pkg: LEXICON, version: "0.102.0" }, parser: { pkg: "@cdktn/hcl2json", version: "0.24.0" }, from: "/behold" });
const pins = (work: string): { package: string; version: string }[] => (JSON.parse(readFileSync(join(work, "chant.workspace.json"), "utf8")) as { pins: { package: string; version: string }[] }).pins;

// #484: chant reads a workspace's pinned kinds from the workspace's own
// node_modules at exactly the pinned version; a demo copy has neither.
describe("linkDemoPins (#484)", () => {
  it("links the pinned lexicon behold resolved into the copy and pins the copy at its version", () => {
    const { work, pkgDir } = copy([{ package: LEXICON, version: "0.95.0" }]);
    const got = linkDemoPins(work, { resolve: () => ({ dir: pkgDir, version: "0.102.0" }), reader: readable });
    expect(got).toEqual({ ok: true, linked: [{ pkg: LEXICON, version: "0.102.0", was: "0.95.0" }] });
    const link = join(work, "node_modules", "@intentius", "chant-lexicon-terraform");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(pkgDir);
    expect(pins(work)).toEqual([{ package: LEXICON, version: "0.102.0" }]);
  });

  it("is idempotent on a reused copy", () => {
    const { work, pkgDir } = copy([{ package: LEXICON, version: "0.95.0" }]);
    const probes = { resolve: () => ({ dir: pkgDir, version: "0.102.0" }), reader: readable };
    linkDemoPins(work, probes);
    expect(linkDemoPins(work, probes)).toEqual({ ok: true, linked: [{ pkg: LEXICON, version: "0.102.0" }] });
  });

  it("refuses with the terraform reader's own install line when the lexicon or its parser is missing", () => {
    const { work } = copy([{ package: LEXICON, version: "0.102.0" }]);
    const got = linkDemoPins(work, {
      resolve: () => undefined,
      reader: () => ({ ...readable(), refusal: { error: "Reading a Terraform estate needs chant's terraform lexicon…", code: "terraform-lexicon", remedy: "Install @intentius/chant-lexicon-terraform@^0.102.0 @cdktn/hcl2json@^0.24.0 beside behold, then reload." } }),
    });
    expect(got).toEqual({
      ok: false,
      error: "Reading a Terraform estate needs chant's terraform lexicon…",
      remedy: "Install @intentius/chant-lexicon-terraform@^0.102.0 @cdktn/hcl2json@^0.24.0 beside behold, then reload.",
    });
  });

  it("refuses a pinned package behold cannot resolve", () => {
    const { work } = copy([{ package: "@acme/kinds", version: "1.0.0" }]);
    const got = linkDemoPins(work, { resolve: () => undefined, reader: readable });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.remedy).toBe("Install @acme/kinds beside behold, then load the demo again.");
  });

  it("leaves a real install in the copy alone", () => {
    const { work, pkgDir } = copy([{ package: LEXICON, version: "0.95.0" }]);
    mkdirSync(join(work, "node_modules", "@intentius", "chant-lexicon-terraform"), { recursive: true });
    expect(linkDemoPins(work, { resolve: () => ({ dir: pkgDir, version: "0.102.0" }), reader: readable })).toEqual({ ok: true, linked: [] });
    expect(pins(work)).toEqual([{ package: LEXICON, version: "0.95.0" }]);
  });

  it("does nothing for a copy with no declaration", () => {
    expect(linkDemoPins(scratch())).toEqual({ ok: true, linked: [] });
  });
});

// The whole path, where the lexicon is installed beside behold (it is an
// optional peer, so CI has none): a copy of the bundled demo, loaded the way
// `behold demo` loads it, is one chant lists with both members readable.
describe("behold demo terraform-estate, against chant (#484)", () => {
  const installed = resolvedPackage(LEXICON) && resolvedPackage("@cdktn/hcl2json");
  it.skipIf(!installed && !REQUIRE_PEERS)("lists both roots as terraform members chant can read", { timeout: 60_000 }, async () => {
    const entry = loadDemoRegistry(REPO).find((e) => e.name === "terraform-estate")!;
    const target = join(scratch(), "terraform-estate");
    const loaded = await loadDemo(entry, { pkgRoot: REPO, target });
    expect(loaded.ok).toBe(true);
    const read = await readWorkspace(target);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.workspace.members.map((m) => [m.name, m.kind, m.reason])).toEqual([["prod", "terraform", null], ["platform", "terraform", null]]);
  });
});
