import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeStacks } from "@intentius/pinhole";
import {
  RUNGS,
  SCHEMA_SOURCES,
  addChoudoufuReferenceEdges,
  choudoufuCardFields,
  choudoufuMeetsFloor,

  dataSourceKind,
  hasLiveBlock,
  isDevBuild,
  liveCheckToIr,
  parseChoudoufuVersion,
  parseLiveCheck,
  parseLiveCheckOutput,
  readLiveCheck,
  type LiveCheckDocument,
} from "./choudoufu-member.ts";
import { choudoufuSpec } from "./choudoufu-live.ts";

// Fixture provenance (#369). Every document below was printed by
// `choudoufu live-check -json` from a choudoufu built from main at
// `9c7d3701e2` (v0.15.0 plus the #966/#967/#968 merges of 2026-09-08, which
// is what puts `schemas` on the document; a v0.15.0 release binary does not
// carry it). Nothing was hand-edited.
//
//  - choudoufu-live-check-monolith-builtin.json: the live-mv workbench's
//    `tests/fixtures/sample-run/estates/tlmig-sample-monolith` (21 instances,
//    no data sources) as checked in — no `.terraform`, so `schemas: "builtin"`
//    and every rung `declaration-carried`.
//  - choudoufu-live-check-monolith.json: the same directory after
//    `choudoufu init` — `schemas: "provider"`, 15 `tag-governable`, 6
//    `declaration-carried` (the inline policies and attachments, which have
//    no tags argument).
//  - choudoufu-live-check-consumer.json: a two-subnet estate (`spike-app`)
//    reading a `spike-net` estate's VPC through a data source filtered on the
//    producer's marker tags — the live/OUTPUTS.md pattern — after init.
//  - choudoufu-live-check-estate-references.json: choudoufu's own
//    `live/e2e/estate-references` fixture (no provider block, no init, no
//    `live` block — so no `estate` on the document).
const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(HERE, "__fixtures__", name), "utf8"));
const doc = (name: string): LiveCheckDocument => {
  const parsed = parseLiveCheck(fixture(name));
  if (!parsed.ok) throw new Error(parsed.refusal.error);
  return parsed.doc;
};

describe("parseLiveCheck — the document, or a refusal (#369)", () => {
  it("accepts the recorded documents", () => {
    for (const f of ["choudoufu-live-check-monolith-builtin.json", "choudoufu-live-check-monolith.json", "choudoufu-live-check-consumer.json", "choudoufu-live-check-estate-references.json"]) {
      expect(parseLiveCheck(fixture(f)).ok, f).toBe(true);
    }
  });

  it("refuses a non-object, a document with no roster, and a malformed entry", () => {
    expect(parseLiveCheck([])).toMatchObject({ ok: false, refusal: { code: "choudoufu-live-check" } });
    expect(parseLiveCheck({ instances: [] })).toMatchObject({ ok: false, refusal: { error: expect.stringContaining("no `instances` and `references`") } });
    expect(parseLiveCheck({ instances: [{ type: "aws_vpc" }], references: [], schemas: "provider" })).toMatchObject({
      ok: false,
      refusal: { error: "live-check's instances[0] has no string `address`." },
    });
    expect(parseLiveCheck({ instances: [], references: [{ from: "data.x.y" }], schemas: "provider" })).toMatchObject({
      ok: false,
      refusal: { error: expect.stringContaining("references[0]") },
    });
  });

  // choudoufu#966: a document without `schemas` was written by a choudoufu
  // older than the floor, and its rungs cannot be told from an uninitialised
  // directory's. Refused, never read.
  it("refuses a document with no `schemas` field as older than the floor", () => {
    const old = { ...(fixture("choudoufu-live-check-monolith.json") as Record<string, unknown>) };
    delete old.schemas;
    const parsed = parseLiveCheck(old);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.error).toContain("older than 0.16.0");
  });

  it("pins the rung and schemas vocabularies — fails the day choudoufu adds a word", () => {
    const seen = new Set<string>();
    for (const f of ["choudoufu-live-check-monolith-builtin.json", "choudoufu-live-check-monolith.json", "choudoufu-live-check-consumer.json"]) {
      for (const i of doc(f).instances) if (i.rung) seen.add(i.rung);
    }
    expect([...seen].sort()).toEqual(["declaration-carried", "tag-governable"]);
    for (const r of seen) expect(RUNGS).toContain(r);
    expect(RUNGS).toEqual(["tag-governable", "declaration-carried", "record-only"]);
    expect(SCHEMA_SOURCES).toEqual(["provider", "builtin"]);
  });
});

describe("parseLiveCheckOutput — what the spawn printed (#369)", () => {
  it("empty stdout with a non-zero exit is 'could not be read', with choudoufu's own error line", () => {
    const stderr = "[31m╷[0m\n[31m│[0m [1m[31mError: [0mUnclosed configuration block\n│\n│   on main.tf line 1:\n╵\n";
    const parsed = parseLiveCheckOutput({ code: 1, stdout: "", stderr }, "/est/bad");
    expect(parsed).toMatchObject({ ok: false, refusal: { error: "choudoufu could not read /est/bad: Error: Unclosed configuration block" } });
  });

  it("code 127 is 'not on PATH'", () => {
    expect(parseLiveCheckOutput({ code: 127, stdout: "", stderr: "spawn choudoufu ENOENT" }, "/est")).toMatchObject({
      ok: false,
      refusal: { error: expect.stringContaining("not on PATH") },
    });
  });

  it("non-JSON stdout is refused, not half-read", () => {
    expect(parseLiveCheckOutput({ code: 0, stdout: "Usage: choudoufu live-check", stderr: "" }, "/est").ok).toBe(false);
  });

  it("readLiveCheck runs `live-check -json .` in the member dir through the injected spawn", async () => {
    const calls: [string[], string][] = [];
    const parsed = await readLiveCheck("/est/net", async (args, cwd) => {
      calls.push([args, cwd]);
      return { code: 0, stdout: JSON.stringify(fixture("choudoufu-live-check-consumer.json")), stderr: "" };
    });
    expect(calls).toEqual([[["live-check", "-json", "."], "/est/net"]]);
    expect(parsed.ok).toBe(true);
  });
});

describe("liveCheckToIr — the roster and the edges, painted nothing (#369)", () => {
  it("one card per instance, rung and estate in attrs, no _status", () => {
    const ir = liveCheckToIr(doc("choudoufu-live-check-monolith.json"));
    expect(ir.nodes).toHaveLength(21);
    const role = ir.nodes.find((n) => n.id === "aws_iam_role.team_a")!;
    expect(role).toEqual({
      id: "aws_iam_role.team_a",
      kind: "aws_iam_role",
      lexicon: "choudoufu",
      attrs: { estate: "tlmig-sample-monolith", rung: "tag-governable" },
    });
    const inline = ir.nodes.find((n) => n.id === "aws_iam_role_policy.team_a_inline")!;
    expect(inline.attrs.rung).toBe("declaration-carried");
    expect(ir.nodes.some((n) => "_status" in n.attrs)).toBe(false);
    expect(ir.edges).toEqual([]);
  });

  it("a builtin-schemas document says so on every card — the caveat, not a colour", () => {
    const ir = liveCheckToIr(doc("choudoufu-live-check-monolith-builtin.json"));
    expect(ir.nodes.every((n) => typeof n.attrs.schemas === "string" && (n.attrs.schemas as string).startsWith("builtin"))).toBe(true);
    expect(ir.nodes.every((n) => n.attrs.rung === "declaration-carried")).toBe(true);
    const provider = liveCheckToIr(doc("choudoufu-live-check-monolith.json"));
    expect(provider.nodes.some((n) => "schemas" in n.attrs)).toBe(false);
  });

  it("a cross-estate reference is a data-source card with its producer, read by its readers", () => {
    const ir = liveCheckToIr(doc("choudoufu-live-check-consumer.json"));
    expect(ir.nodes.map((n) => n.id).sort()).toEqual(["aws_subnet.app", "aws_subnet.app2", "data.aws_vpc.network"]);
    const ds = ir.nodes.find((n) => n.id === "data.aws_vpc.network")!;
    expect(ds).toEqual({
      id: "data.aws_vpc.network",
      kind: "data.aws_vpc",
      lexicon: "choudoufu",
      attrs: { estate: "spike-app", producer: { estate: "spike-net", address: "aws_vpc.main" } },
    });
    expect(ir.edges).toEqual([
      { from: "aws_subnet.app", to: "data.aws_vpc.network", kind: "ref", viaAttr: "reads" },
      { from: "aws_subnet.app2", to: "data.aws_vpc.network", kind: "ref", viaAttr: "reads" },
    ]);
  });

  it("a document with no estate (no live block) carries none, rather than a guessed one", () => {
    const ir = liveCheckToIr(doc("choudoufu-live-check-estate-references.json"));
    expect(ir.nodes.every((n) => !("estate" in n.attrs))).toBe(true);
    expect(ir.nodes.find((n) => n.id === "data.aws_vpc.network")!.attrs.producer).toEqual({ estate: "estate-references-network", address: "aws_vpc.main" });
  });

  it("a refused instance keeps the rule and the reason as rows", () => {
    const ir = liveCheckToIr({
      dir: ".",
      estate: "e",
      blocked: true,
      exit_code: 1,
      schemas: "provider",
      instances: [{ address: "aws_s3_bucket.b", type: "aws_s3_bucket", refused: true, rule: "RuleUnstable", reason: "server-minted name" }],
      references: [],
      checked: [],
    });
    expect(ir.nodes[0]!.attrs).toEqual({ estate: "e", refused: true, rule: "RuleUnstable", reason: "server-minted name" });
  });

  it("dataSourceKind", () => {
    expect(dataSourceKind("data.aws_vpc.network")).toBe("data.aws_vpc");
    expect(dataSourceKind("module.x.data.aws_vpc.n")).toBe("module.x.data.aws_vpc.n");
  });
});

describe("addChoudoufuReferenceEdges — the cross-member edge (#369, #366's open join)", () => {
  const composed = () =>
    composeStacks([
      { name: "net", ir: liveCheckToIr({ dir: ".", estate: "spike-net", blocked: false, exit_code: 0, schemas: "provider", instances: [{ address: "aws_vpc.main", type: "aws_vpc", rung: "tag-governable" }], references: [], checked: [] }) },
      { name: "app", ir: liveCheckToIr(doc("choudoufu-live-check-consumer.json")) },
    ]);

  it("draws the data source to the producing instance in the member that declares that estate", () => {
    const ir = addChoudoufuReferenceEdges(composed());
    const cross = ir.edges.filter((e) => (e as { inferred?: boolean }).inferred);
    expect(cross).toEqual([{ from: "app/data.aws_vpc.network", to: "net/aws_vpc.main", kind: "ref", viaAttr: "tofu-estate", inferred: true }]);
    expect(ir.nodes.find((n) => n.id === "app/data.aws_vpc.network")!.attrs.reads).toBe("net/aws_vpc.main");
    // Idempotent: the overlay route runs the same pass over a fresh compose,
    // and a second run over the same IR adds nothing.
    expect(addChoudoufuReferenceEdges(ir).edges.filter((e) => (e as { inferred?: boolean }).inferred)).toHaveLength(1);
  });

  it("keeps a producer that is not a member as a row, never a dangling edge", () => {
    const ir = addChoudoufuReferenceEdges(composeStacks([{ name: "app", ir: liveCheckToIr(doc("choudoufu-live-check-consumer.json")) }]));
    expect(ir.edges.some((e) => (e as { inferred?: boolean }).inferred)).toBe(false);
    expect(ir.nodes.find((n) => n.id === "app/data.aws_vpc.network")!.attrs.unresolved).toBe('estate "spike-net" is not a member of this estate');
  });

  it("says when the member is there but the address is not, and when only the estate was named", () => {
    const ir = composed();
    const ds = ir.nodes.find((n) => n.id === "app/data.aws_vpc.network")!;
    ds.attrs = { ...ds.attrs, producer: { estate: "spike-net", address: "aws_vpc.other" } };
    expect(addChoudoufuReferenceEdges(ir).nodes.find((n) => n.id === ds.id)!.attrs.unresolved).toBe("aws_vpc.other is not declared by the net member");
    const ir2 = composed();
    const ds2 = ir2.nodes.find((n) => n.id === "app/data.aws_vpc.network")!;
    ds2.attrs = { ...ds2.attrs, producer: { estate: "spike-net" } };
    expect(addChoudoufuReferenceEdges(ir2).nodes.find((n) => n.id === ds2.id)!.attrs.unresolved).toContain("as a whole");
  });

  it("is the identity on an estate with no choudoufu member", () => {
    const ir = composeStacks([{ name: "a", ir: { nodes: [{ id: "x", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: {} }], edges: [], groups: {} } }]);
    const before = JSON.stringify(ir);
    expect(JSON.stringify(addChoudoufuReferenceEdges(ir))).toBe(before);
  });
});

describe("choudoufuCardFields — the presentation pack (#369)", () => {
  it("leads with rung and estate for an instance, and the producer for a data source", () => {
    expect(choudoufuCardFields({ attrs: { estate: "e", rung: "tag-governable", schemas: "builtin" } })).toEqual([
      { label: "rung", value: "tag-governable" },
      { label: "estate", value: "e" },
    ]);
    expect(choudoufuCardFields({ attrs: { estate: "app", producer: { estate: "net", address: "aws_vpc.main" } } })).toEqual([{ label: "reads", value: "net aws_vpc.main" }]);
    expect(choudoufuCardFields({ attrs: { score: 3 } })).toBeUndefined();
  });
});

describe("the probe and the floor (#369)", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const make = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "behold-choudoufu-"));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  };

  it("hasLiveBlock: a root *.tf with a live block, by regex, root files only", () => {
    expect(hasLiveBlock(make({ "main.tf": 'terraform {\n  live {\n    estate = "x"\n  }\n}\n' }))).toBe(true);
    expect(hasLiveBlock(make({ "main.tf": 'resource "aws_vpc" "x" {}\n' }))).toBe(false);
    expect(hasLiveBlock(make({ "sub/main.tf": "live {\n}\n" }))).toBe(false);
    expect(hasLiveBlock(make({ "notes.txt": "live {" }))).toBe(false);
    expect(hasLiveBlock("/nonexistent/dir")).toBe(false);
    expect(choudoufuSpec.probe).toBe(hasLiveBlock);
  });

  it("parseChoudoufuVersion: the field's presence is the floor's real check (choudoufu#968)", () => {
    expect(parseChoudoufuVersion('{"choudoufu_version":"v0.16.0","terraform_version":"1.13.0","platform":"darwin_arm64","provider_selections":{}}')).toEqual({
      bin: "choudoufu",
      version: "v0.16.0",
      forkField: true,
      upstream: "1.13.0",
    });
    // v0.15.0 and older: no key at all.
    const old = parseChoudoufuVersion('{"terraform_version":"1.13.0-dev","platform":"darwin_arm64","provider_selections":{}}')!;
    expect(old.forkField).toBe(false);
    expect(choudoufuMeetsFloor(old)).toBe(false);
    expect(parseChoudoufuVersion("not json")).toBeUndefined();
  });

  it("choudoufuMeetsFloor: a release at or past 0.16.0, or any build from main, meets it", () => {
    const at = (version: string) => choudoufuMeetsFloor({ bin: "choudoufu", version, forkField: true });
    expect(at("v0.16.0")).toBe(true);
    expect(at("v0.17.2")).toBe(true);
    expect(at("v0.15.0")).toBe(false);
    expect(at("v0.15.0-30-g9c7d3701e2")).toBe(true); // a git-describe build is past its base tag
    expect(at("")).toBe(true); // a development build with no ldflag
    expect(isDevBuild("v0.16.0")).toBe(false);
  });
});
