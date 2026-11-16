import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";

// behold#1105: `--no-source` leaves out the text a card's values carry, in
// every snapshot and in graph.json, and shows a marker where it did.
vi.mock("./chant.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chant.ts")>()),
  graphIr: vi.fn(),
}));
import { graphIr } from "./chant.ts";
import { VALUE_LEFT_OUT, bundleFiles, isSourceText, runExport } from "./export.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const base = (): GraphIR => JSON.parse(readFileSync(join(HERE, "__fixtures__", "terraform-ir-two-roots.json"), "utf8")) as GraphIR;

const HEREDOC_LINE = "echo BEHOLD1105-HEREDOC-BODY >> /etc/motd";
const MULTILINE_LINE = "BEHOLD1105-MULTILINE-STRING second line";
const FOR_EACH_COMMENT = "BEHOLD1105-FOR-EACH-COMMENT temporary shim";
const FOR_EACH_TEXT = "BEHOLD1105_group_for_each";

/** The first Terraform node gets a heredoc, a multi-line string and a `for_each` expression with an inline comment. */
const withSource = (): GraphIR => {
  const ir = base();
  const node = ir.nodes.find((n) => n.lexicon === "terraform")!;
  const attrs = node.attrs as Record<string, unknown>;
  attrs.body = {
    ...(attrs.body as Record<string, unknown>),
    user_data: `<<-EOT\n#!/bin/bash\n${HEREDOC_LINE}\nEOT\n`,
    notes: `first line\n${MULTILINE_LINE}\n`,
    for_each: `{ for g in local.${FOR_EACH_TEXT} : g => 1 } // ${FOR_EACH_COMMENT}`,
    nested: { script: `a\n${HEREDOC_LINE}` },
    region: "us-east-1",
    subnet: "${aws_subnet.main.id}",
  };
  attrs.evaluated = { stopped: { for_each: `merge([ for g in local.${FOR_EACH_TEXT} : { ${FOR_EACH_COMMENT} } ])`, vpc: "aws_vpc.main.id" } };
  attrs.instanceRollup = { code: "instances-form-unread", argument: "for_each", expression: `length(local.${FOR_EACH_TEXT}) > 0 ? 1 : 0` };
  attrs.source = `# BEHOLD1105-WHOLE-FILE\n`;
  return ir;
};

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

async function exportTo(ir: GraphIR, noSource: boolean): Promise<string> {
  vi.mocked(graphIr).mockImplementation((async () => ir) as never);
  const project = mkdtempSync(join(tmpdir(), "behold-nosource-src-"));
  const root = mkdtempSync(join(tmpdir(), "behold-nosource-out-"));
  made.push(project, root);
  const out = join(root, "bundle");
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await runExport({ projectDir: project, port: 0 }, out, noSource ? { noSource: true } : {});
  } finally {
    write.mockRestore();
  }
  return out;
}

const NEEDLES = [HEREDOC_LINE, MULTILINE_LINE, FOR_EACH_COMMENT, FOR_EACH_TEXT, "BEHOLD1105-WHOLE-FILE"];
/** The text as a file holds it: raw, and with the JSON escapes a snapshot adds. */
const forms = (s: string) => [s, JSON.stringify(s).slice(1, -1)];
const siteText = (out: string): Map<string, string> => new Map(bundleFiles(out).map((f) => [f, readFileSync(join(out, f), "utf8")]));

describe("export --no-source leaves out values that are source text (#1105)", () => {
  it("finds none of the fixture's heredoc, multi-line string or for_each text in any file, and all of it without the flag", { timeout: 120_000 }, async () => {
    const without = await exportTo(withSource(), true);
    const files = siteText(without);
    expect([...files.keys()].some((f) => f.includes("detail=3"))).toBe(true);
    expect([...files.keys()].some((f) => f.includes("logical=1"))).toBe(true);
    expect(files.has("graph.json")).toBe(true);
    for (const [file, text] of files) for (const n of NEEDLES) for (const form of forms(n)) expect(text.includes(form), `${file} holds ${n}`).toBe(false);

    const withFlagOff = siteText(await exportTo(withSource(), false));
    for (const n of NEEDLES) expect([...withFlagOff.values()].some((t) => forms(n).some((f) => t.includes(f))), `${n} should be present without the flag`).toBe(true);
  });

  it("shows the marker where a value was left out and keeps names, references and short literals", { timeout: 120_000 }, async () => {
    const out = await exportTo(withSource(), true);
    const detail3Of = (dir: string) => join(dir, "snapshots", readdirSync(join(dir, "snapshots")).find((f) => f.startsWith("api_graph_detail=3.") && !f.includes("radial"))!);
    const snap = JSON.parse(readFileSync(detail3Of(out), "utf8")) as { ir: GraphIR };
    const node = snap.ir.nodes.find((n) => (n.attrs as Record<string, unknown>).body && ((n.attrs as { body: Record<string, unknown> }).body.region === "us-east-1"))!;
    const body = (node.attrs as { body: Record<string, unknown> }).body;
    expect(body.user_data).toBe(VALUE_LEFT_OUT);
    expect(body.notes).toBe(VALUE_LEFT_OUT);
    expect(body.for_each).toBe(VALUE_LEFT_OUT);
    expect((body.nested as Record<string, unknown>).script).toBe(VALUE_LEFT_OUT);
    expect(body.region).toBe("us-east-1");
    expect(body.subnet).toBe("${aws_subnet.main.id}");
    const attrs = node.attrs as Record<string, unknown>;
    expect((attrs.evaluated as { stopped: Record<string, string> }).stopped).toEqual({ for_each: VALUE_LEFT_OUT, vpc: "aws_vpc.main.id" });
    expect((attrs.instanceRollup as Record<string, string>).expression).toBe(VALUE_LEFT_OUT);
    expect(attrs.address).toBeTruthy();
    expect(attrs.source).toBeUndefined();
    // The graph is the same size: nothing but values went.
    const full = JSON.parse(readFileSync(detail3Of(await exportTo(withSource(), false)), "utf8")) as { ir: GraphIR };
    expect(snap.ir.nodes.length).toBe(full.ir.nodes.length);
    expect(snap.ir.edges).toEqual(full.ir.edges);
  });

  it("classifies strings", () => {
    expect(isSourceText("<<EOT\nx\nEOT", false)).toBe(true);
    expect(isSourceText("a\nb", false)).toBe(true);
    expect(isSourceText("${length(var.x)}", false)).toBe(true);
    expect(isSourceText("x".repeat(200), false)).toBe(true);
    expect(isSourceText("us-east-1", false)).toBe(false);
    expect(isSourceText("arn ${data.aws_caller_identity.current.arn}", false)).toBe(false);
    expect(isSourceText("local.groups", true)).toBe(false);
    expect(isSourceText("length(var.x) > 0 ? 1 : 0", true)).toBe(true);
  });
});
