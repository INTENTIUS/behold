/**
 * A Terraform root chant could not parse, drawn as a card (behold#1053).
 *
 * chant's Terraform lexicon turns a root whose `.tf` does not parse into a
 * warning on stderr and zero entities for that root, with exit 0. The IR
 * carries nothing about it, so a root with one bad file drew as a root that
 * held nothing, and the read said nothing. behold hears the warning (the
 * `onStderr` hook on `graphIr`) and gives the root one card in the shape an
 * unreadable workspace member already has (`unreadableMemberIr`,
 * src/workspace.ts): kind `UnreadableMember`, `attrs._unreadable: { code,
 * message }`, plus the file and line the parser named.
 *
 * The card carries the terraform lexicon and the root's name in `attrs.root`,
 * so `groupTerraformByRoot` boxes it with the roots that did parse, and no
 * pass keyed on a block class (`attrs.block`) touches it.
 */
import type { GraphIR } from "@intentius/chant";
import { stripAnsi } from "./ansi.ts";

/** The reason code the card carries in `_unreadable.code`. */
export const TERRAFORM_PARSE_CODE = "terraform-parse";

/** The card's kind, the same one a workspace member chant cannot read has. */
export const UNPARSED_KIND = "UnreadableMember";

export interface UnparsedRoot {
  /** The root's name, as the scratch config keys it. */
  root: string;
  /** The file the parser named, relative to the root, when its message names one. */
  file?: string;
  /** The line, when the message names one. */
  line?: number;
  /** The parser's own words, without the location. */
  detail: string;
}

/**
 * The roots chant says it could not parse, from what it wrote to stderr.
 * chant's line is `terraform.roots.<name>: could not parse <dir>, <message>`,
 * where the message for a malformed file is `parse config: [main.tf:8,19-22:
 * Missing newline after argument; An argument definition must end with a
 * newline.]`. A message in any other shape still gives a card, with the whole
 * message as its detail.
 */
export function parseUnparsedRoots(stderr: string): UnparsedRoot[] {
  const found = new Map<string, UnparsedRoot>();
  for (const raw of stripAnsi(stderr).split(/\r?\n/)) {
    const m = raw.match(/^(?:warning:\s*)?terraform\.roots\.([^\s:]+): could not parse (\S+?), ([\s\S]*)$/);
    if (!m) continue;
    const [, root, , message] = m;
    const located = message.match(/\[([^\s:\[\]]+):(\d+)(?:,[\d-]+)?:\s*([\s\S]*?)\]?\s*$/);
    found.set(root, located ? { root, file: located[1], line: Number(located[2]), detail: located[3].trim() } : { root, detail: message.replace(/^parse config:\s*/, "").trim() });
  }
  return [...found.values()];
}

/** The words the card shows: where, then what the parser said. */
function cardMessage(u: UnparsedRoot): string {
  const where = u.file ? `${u.file}${u.line ? `:${u.line}` : ""}: ` : "";
  return `${where}${u.detail}`;
}

/**
 * Add one card per unparsed root to `ir` (mutating, like the passes that
 * follow). A root that did parse is left alone, so a stale warning for a root
 * that has nodes adds nothing. `dirOf` maps a root's name to its directory
 * relative to the member, when the caller knows it.
 */
export function addUnparsedRootCards(ir: GraphIR, unparsed: readonly UnparsedRoot[], dirOf: (root: string) => string | undefined = () => undefined): GraphIR {
  for (const u of unparsed) {
    if (ir.nodes.some((n) => n.attrs.root === u.root && n.kind !== UNPARSED_KIND)) continue;
    const id = `${u.root}/unreadable`;
    if (ir.nodes.some((n) => n.id === id)) continue;
    const dir = dirOf(u.root);
    ir.nodes.push({
      id,
      kind: UNPARSED_KIND,
      lexicon: "terraform",
      attrs: {
        _status: "neutral",
        _unreadable: { code: TERRAFORM_PARSE_CODE, message: cardMessage(u) },
        root: u.root,
        ...(dir !== undefined ? { dir } : {}),
        kind: "terraform",
        ...(u.file ? { file: u.file } : {}),
        ...(u.line ? { line: u.line } : {}),
      },
    } as unknown as GraphIR["nodes"][number]);
  }
  return ir;
}

/** Is this node a root's unparsed card? */
export function isUnparsedRootCard(node: { kind: string; attrs: Record<string, unknown> }): boolean {
  return node.kind === UNPARSED_KIND && (node.attrs._unreadable as { code?: string } | undefined)?.code === TERRAFORM_PARSE_CODE;
}

/** The unparsed roots an IR carries cards for, in node order. */
export function unparsedRootCards(ir: Pick<GraphIR, "nodes">): { root: string; file?: string; line?: number }[] {
  return ir.nodes.filter(isUnparsedRootCard).map((n) => ({
    root: String(n.attrs.root),
    ...(typeof n.attrs.file === "string" ? { file: n.attrs.file } : {}),
    ...(typeof n.attrs.line === "number" ? { line: n.attrs.line } : {}),
  }));
}

/**
 * The note's clause and its chip: "1 of 2 roots could not be parsed (app:
 * main.tf:8)". `total` is how many roots the folders held. Undefined when
 * every root parsed.
 */
export function unparsedNote(cards: readonly { root: string; file?: string; line?: number }[], total: number): { note?: string; noteShort?: string } {
  if (!cards.length) return {};
  const of = Math.max(total, cards.length);
  const named = cards.map((c) => (c.file ? `${c.root}: ${c.file}${c.line ? `:${c.line}` : ""}` : c.root)).join(", ");
  const roots = `root${of === 1 ? "" : "s"}`;
  return {
    note: `${cards.length} of ${of} ${roots} could not be parsed (${named})`,
    noteShort: `${cards.length} of ${of} ${roots} not parsed`,
  };
}
