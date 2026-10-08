// #468: chant's reader conformance suite (ws-052) over behold's workspace
// reader, src/workspace-reader.ts, the one module every workspace read goes
// through.
//
// The suite generates a workspace from the fixture the installed
// @intentius/chant ships, builds the reader over a recording transport (never
// the path), and for each command checks that the read was exactly one chant
// call of the contract command with its JSON flag, that the document returned
// is the one chant printed, that it validates against chant's schema at this
// contract version, and that no file in the workspace changed.
//
// The reader returns chant's document unchanged, so the suite can compare it.
// What behold makes of that document is checked here too: each read also runs
// the parser behold uses on it, and a document behold could not use fails the
// read, as hud's adapter does (arugula-salad/hud reader-conformance.test.ts).
import { describe, expect, it } from "vitest";
import { describeWorkspaceReaderConformance, type ChantTransport, type ReadContractCommand } from "@intentius/chant/workspace/conformance/vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { workspaceFromLs, memberIrFromGraphDocument } from "./workspace.ts";
import { gatesFromStatus } from "./workspace-gates.ts";
import { BEHOLD_READS, workspaceReader, type WorkspaceDocument, type WorkspaceReadCommand } from "./workspace-reader.ts";

/** The suite fixture's chant member, the one `graph --member` reads. */
const FIXTURE_MEMBER = "delivery";

/** Run behold's own parser for `command` over the document, and throw when it can't use it. */
function use(command: WorkspaceReadCommand, doc: WorkspaceDocument): void {
  if (command === "ls") {
    const read = workspaceFromLs(doc, "/conformance");
    if (!read.ok) throw new Error(`behold could not use the ls document: ${read.refusal.error}`);
  } else if (command === "graph") {
    memberIrFromGraphDocument(doc, FIXTURE_MEMBER);
  } else if (command === "status") {
    const read = gatesFromStatus(doc, "/conformance");
    if (!read.ok) throw new Error(`behold could not use the status document: ${read.refusal.error}`);
  }
}

describeWorkspaceReaderConformance({
  name: "behold",
  commands: BEHOLD_READS.filter((c) => c !== "graph --intent") as ReadContractCommand[],
  reader: (chant: ChantTransport) => {
    const reader = workspaceReader({ run: (argv) => chant.run(argv) });
    return {
      async read(command: ReadContractCommand, args: string[]) {
        const doc = await reader.read(command as WorkspaceReadCommand, args);
        use(command as WorkspaceReadCommand, doc);
        return doc;
      },
    };
  },
});

// The suite holds what goes through the reader. This holds the rest of src/
// to going through it: no other module names a workspace command to chant.
describe("every workspace read goes through the reader (#468)", () => {
  it("no module but the reader runs a read-contract command (doctor --fix runs check, a write's own validation)", () => {
    const src = join(import.meta.dirname, ".");
    const offenders: string[] = [];
    for (const f of readdirSync(src)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "workspace-reader.ts") continue;
      const text = readFileSync(join(src, f), "utf8");
      if (/\[\s*"workspace"\s*,\s*"(ls|graph|status|records|runs|wip)"/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
