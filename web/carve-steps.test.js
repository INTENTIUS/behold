// #254: the pure half of web/carve-steps.js, tested the way web/json-view.js
// (#259) and web/layout-store.js (#245) are — no DOM, no jsdom, no browser.
// Everything the stepper DECIDES (which step is reachable, what the Pick step
// can honestly claim about the cut, which runbook lines are commands, what
// `chant lint` reads as) is a function from data to data, so it is checkable
// here; the DOM half — the buttons, the copy controls, the six-step walk — is
// smoke/ui-smoke.mjs's job.
import { describe, it, expect } from "vitest";
import {
  CARVE_STEPS,
  blockedReason,
  carveable,
  completed,
  cutSummary,
  edgeLine,
  initialCarveState,
  lintVerdict,
  pickFacts,
  runbookCommands,
  stepStatus,
} from "./carve-steps.js";

const BUCKET = {
  address: "aws_s3_bucket.assets",
  score: 88,
  band: "clean leaf",
  mapsTo: "AWS::S3::Bucket",
  breakdown: { inbound: 1, outbound: 0, tier: 1 },
};
const NODE = { id: "aws_s3_bucket.assets", attrs: { arithmetic: "100 - 12x1 inbound = 88", score: 88, band: "clean leaf", tier: 1 } };

const picked = () => ({ ...initialCarveState(), step: 1, pick: { node: NODE, resource: BUCKET } });

describe("the six steps", () => {
  it("are the six #254 names, in order", () => {
    expect(CARVE_STEPS.map((s) => s.id)).toEqual(["advise", "pick", "emit", "bridge", "handoff", "done"]);
  });
});

describe("blockedReason — the gates are real data dependencies", () => {
  it("blocks emit until something is picked", () => {
    expect(blockedReason(initialCarveState(), "emit")).toContain("Pick a resource first");
    expect(blockedReason(picked(), "emit")).toBeNull();
  });

  it("blocks bridge until emit ran, and says why: the manifest emit leaves behind", () => {
    expect(blockedReason(picked(), "bridge")).toContain("carve manifest");
    expect(blockedReason({ ...picked(), emit: { ok: true } }, "bridge")).toBeNull();
  });

  it("blocks handoff until bridge wrote the runbook", () => {
    const s = { ...picked(), emit: { ok: true } };
    expect(blockedReason(s, "handoff")).toContain("Run Bridge first");
    expect(blockedReason({ ...s, bridge: { ok: true } }, "handoff")).toBeNull();
  });

  it("never blocks advise or pick — the walkthrough always has a first frame", () => {
    expect(blockedReason(initialCarveState(), "advise")).toBeNull();
    expect(blockedReason(initialCarveState(), "pick")).toBeNull();
  });
});

describe("completed / stepStatus", () => {
  it("a fresh walkthrough is on advise, with everything past pick blocked", () => {
    const s = initialCarveState();
    expect(stepStatus(s, 0)).toBe("current");
    expect(stepStatus(s, 1)).toBe("todo");
    expect(stepStatus(s, 2)).toBe("blocked");
    expect(stepStatus(s, 5)).toBe("blocked");
  });

  it("a step reads done from its RESULT, not from having walked past it", () => {
    const s = { ...picked(), step: 3 };
    expect(completed(s, "emit")).toBe(false);
    expect(stepStatus(s, 2)).toBe("todo"); // stepped past emit without running it
    expect(completed({ ...s, emit: { ok: true } }, "emit")).toBe(true);
  });

  it("done needs the handoff acknowledged AND the bridge run", () => {
    const s = { ...picked(), emit: { ok: true }, bridge: { ok: true } };
    expect(completed(s, "done")).toBe(false);
    expect(completed({ ...s, handoff: true }, "done")).toBe(true);
  });
});

describe("cutSummary — counts and edge lists are different claims", () => {
  it("names the survivors when the report carries the edge lists (chant#1636)", () => {
    const withEdges = {
      ...BUCKET,
      boundary: {
        inbound: [
          {
            direction: "inbound",
            survivor: "aws_lambda_function.api",
            carved: "aws_s3_bucket.assets",
            attrs: ["bucket"],
            via: ["environment"],
            bridge: "tf-data-source",
            required: "immediately",
          },
        ],
        outbound: [],
      },
    };
    const cut = cutSummary(withEdges);
    expect(cut.known).toBe(true);
    expect(cut.items[0]).toContain("aws_lambda_function.api");
    expect(cut.items[0]).toContain("data source");
    expect(cut.note).toBeNull();
  });

  it("falls back to the counts, and SAYS the survivors aren't in this report", () => {
    const cut = cutSummary(BUCKET);
    expect(cut.known).toBe(false);
    expect(cut.items[0]).toContain("1 inbound");
    expect(cut.note).toContain("chant#1636");
  });

  it("distinguishes 'no edges' from 'not reported'", () => {
    const clean = cutSummary({ ...BUCKET, breakdown: { inbound: 0, outbound: 0, tier: 1 } });
    expect(clean.items[0]).toContain("No boundary edges at all");
    expect(clean.note).toBeNull();
  });

  it("reads either shape of the boundary field", () => {
    const flat = cutSummary({ ...BUCKET, boundary: [{ survivor: "a", carved: "b", direction: "outbound" }] });
    expect(flat.known).toBe(true);
  });

  it("falls back to the IR node's own counts when the raw report isn't in hand", () => {
    // The lens puts inbound/outbound on every card, so a pick made before the
    // extra /api/carve fetch lands still says something true — rather than
    // claiming "no boundary edges at all", which would be a different (and
    // wrong) statement about the same resource.
    const cut = cutSummary(null, { id: "aws_s3_bucket.assets", attrs: { inbound: 1, outbound: 0 } });
    expect(cut.items[0]).toContain("1 inbound");
    expect(cut.note).toContain("chant#1636");
  });

  it("still reads a genuine zero as zero, not as missing", () => {
    const cut = cutSummary(null, { id: "x", attrs: { inbound: 0, outbound: 0 } });
    expect(cut.items[0]).toContain("No boundary edges at all");
  });
});

describe("edgeLine", () => {
  it("reads an inbound edge as the survivor's problem and an outbound as ours", () => {
    expect(edgeLine({ direction: "inbound", survivor: "lambda", carved: "bucket", attrs: ["bucket"] })).toContain("lambda reads bucket");
    expect(edgeLine({ direction: "outbound", survivor: "vpc", carved: "sg", attrs: ["id"] })).toContain("from vpc");
    expect(edgeLine({ direction: "outbound", survivor: "vpc", carved: "sg", bridge: "deferred-input" })).toContain("deploy-time input");
  });

  it("names an output block's fix as a rewrite, not a data source (chant#1638)", () => {
    const line = edgeLine({
      direction: "inbound",
      survivor: "output.assets_bucket",
      carved: "aws_s3_bucket.assets",
      attrs: ["bucket"],
      via: ["value"],
      bridge: "tf-output-rewrite",
      required: "immediately",
    });
    expect(line).toContain("output.assets_bucket reads bucket");
    expect(line).toContain("output rewrite");
    expect(line).not.toContain("data source");
  });
});

describe("pickFacts / carveable", () => {
  it("shows the arithmetic the lens already spelled out", () => {
    const facts = pickFacts(NODE, BUCKET);
    expect(facts.map((f) => f.label)).toEqual(["address", "score", "arithmetic", "maps to", "tier"]);
    expect(facts[2].value).toBe("100 - 12x1 inbound = 88");
  });

  it("says up front when a resource has no native mapping to carve into", () => {
    expect(carveable(BUCKET, NODE)).toBeNull();
    const unmappable = { address: "random_pet.suffix", score: 0, band: "leave in Terraform", breakdown: { tier: null } };
    expect(carveable(unmappable, { id: "random_pet.suffix", attrs: { tier: "none" } })).toContain("no known native mapping");
  });
});

describe("runbookCommands", () => {
  // chant's own runbook shape (carve bridge, 0.44.4), trimmed.
  const RUNBOOK = `# Carve-out: aws_s3_bucket.assets → chant   [observe-first, reversible]

## 1. Review the emitted chant source
    (produced by \`chant carve emit\` — confirm it builds to a spec-true template)

## 2. Stop Terraform managing the resource (does NOT destroy it)
    terraform state rm aws_s3_bucket.assets aws_s3_bucket_versioning.assets

## 3. Confirm no destroy, then patch the survivors
    terraform plan   # expect 0 to destroy
    # the generated bridge patch removes the carved block(s)
    terraform plan   # expect: in-place updates to the survivors only
    terraform apply

## Rollback (any time before apply-graduation)
    terraform import aws_s3_bucket.assets <physical-id>
`;

  it("takes the indented commands, in order, under their own headings", () => {
    const cmds = runbookCommands(RUNBOOK);
    expect(cmds.map((c) => c.command)).toEqual([
      "terraform state rm aws_s3_bucket.assets aws_s3_bucket_versioning.assets",
      "terraform plan",
      "terraform apply",
      "terraform import aws_s3_bucket.assets <physical-id>",
    ]);
    expect(cmds[0].section).toContain("Stop Terraform managing");
  });

  it("drops annotations, keeps a trailing comment as the row's note, and dedupes", () => {
    const cmds = runbookCommands(RUNBOOK);
    expect(cmds.some((c) => c.command.startsWith("("))).toBe(false);
    expect(cmds.some((c) => c.command.startsWith("#"))).toBe(false);
    expect(cmds.filter((c) => c.command === "terraform plan")).toHaveLength(1);
    expect(cmds[1].note).toBe("expect 0 to destroy");
  });

  it("survives an empty or missing runbook", () => {
    expect(runbookCommands("")).toEqual([]);
    expect(runbookCommands(null)).toEqual([]);
  });
});

describe("lintVerdict", () => {
  it("counts warnings off chant's SUMMARY line, not the column numbers above it", () => {
    const output =
      "     5:1    warning  Exported declarable 'assets' is never referenced.  COR004\n" +
      "     5:23   warning  S3 Bucket created without encryption configuration.  WAW006\n" +
      "     7:9    warning  Inline object in Declarable constructor.  COR001\n\n" +
      "⚠ 3 warnings";
    expect(lintVerdict({ ok: true, code: 0, output }).text).toBe("chant lint: passes, 3 warning(s)");
  });

  it("reads a clean run and a failing one", () => {
    expect(lintVerdict({ ok: true, code: 0, output: "" }).text).toBe("chant lint: passes");
    const bad = lintVerdict({ ok: false, code: 1, output: "✖ 2 errors" });
    expect(bad.tone).toBe("bad");
    expect(bad.text).toContain("exited 1");
  });

  it("is null with no lint at all — nothing to claim", () => {
    expect(lintVerdict(null)).toBeNull();
  });
});
