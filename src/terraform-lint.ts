/**
 * The lint findings of a bare Terraform estate, kept visible (#919).
 *
 * behold's scratch config for a bare Terraform folder sets chant's
 * `graph.lint: "report"` (chant 0.124.46, src/chant-floors.ts), so `chant graph`
 * draws an estate whose HCL fails one of the lexicon's error rules instead of
 * refusing it, and carries every finding on the IR's `meta.lint`. An
 * error-severity finding there describes the estate (SSH open to the world, a
 * database stored unencrypted), and #908's demo asks about exactly those.
 *
 * Two things happen to the findings here, and neither drops one:
 *
 *  - {@link attachLintFindings} puts each error finding on the node it names,
 *    as `attrs._lint`, so it travels with the card through estate composition
 *    (which keeps nodes and nothing above them) and shows in the inspect pane.
 *    The bare-folder read calls it, and so does the read of a declared
 *    workspace member (src/workspace.ts): `chant workspace graph` writes the
 *    same `graph.lint` into the reader project of a terraform or choudoufu
 *    member, so such a member is composed with its findings on its `meta`
 *    rather than failed with `command-failed`. Both paths behave alike.
 *  - {@link terraformLintNote} says on the note how many errors lint found and
 *    where, before the zoom elides anything, so a finding on a block the
 *    current detail does not draw is still named.
 *
 * Warnings stay on `meta.lint` only. Every bare estate gets several (no
 * remote backend, no `required_version`), and a note that lists them would
 * bury the errors.
 *
 * Pure: reads and annotates the IR it is handed.
 */
import type { GraphIR } from "@intentius/chant";

/** One finding as chant's `meta.lint` carries it. `entity` is the node id a lexicon check named. */
export interface LintFinding {
  ruleId: string;
  severity: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  entity?: string;
}

/** What `chant graph` writes on `meta.lint` under `graph.lint: "report"`. */
export interface LintReport {
  errors: number;
  warnings: number;
  findings: LintFinding[];
}

/** What a card carries on `attrs._lint`: the error findings about it. */
export type CardLintFinding = Pick<LintFinding, "ruleId" | "message">;

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** The IR's `meta.lint`, when chant wrote one this reader understands. */
export function lintReportOf(ir: Pick<GraphIR, "meta">): LintReport | undefined {
  const lint = rec(rec(ir.meta)?.lint);
  if (!lint || !Array.isArray(lint.findings) || typeof lint.errors !== "number") return undefined;
  const findings = lint.findings
    .map(rec)
    .filter((f): f is Record<string, unknown> => !!f && typeof f.ruleId === "string" && typeof f.severity === "string")
    .map((f) => f as unknown as LintFinding);
  return { errors: lint.errors, warnings: typeof lint.warnings === "number" ? lint.warnings : 0, findings };
}

/**
 * Put each error finding of `meta.lint` on the node its `entity` names, as
 * `attrs._lint`. Idempotent: a node's list is rebuilt from the report, never
 * appended to, so the member read and the pass may both call it. A finding
 * whose entity names no node stays on `meta.lint`, and the note counts it.
 */
export function attachLintFindings(ir: GraphIR): void {
  const report = lintReportOf(ir);
  if (!report) return;
  const byEntity = new Map<string, CardLintFinding[]>();
  for (const f of report.findings) {
    if (f.severity !== "error" || !f.entity) continue;
    const list = byEntity.get(f.entity) ?? [];
    list.push({ ruleId: f.ruleId, message: f.message });
    byEntity.set(f.entity, list);
  }
  for (const node of ir.nodes) {
    const found = byEntity.get(node.id);
    if (found) node.attrs = { ...node.attrs, _lint: found };
  }
}

/** The error findings cards carry, by node id. */
function cardFindings(ir: Pick<GraphIR, "nodes">): { id: string; findings: CardLintFinding[] }[] {
  const out: { id: string; findings: CardLintFinding[] }[] = [];
  for (const node of ir.nodes) {
    const lint = (node.attrs as Record<string, unknown> | undefined)?._lint;
    if (Array.isArray(lint) && lint.length > 0) out.push({ id: node.id, findings: lint as CardLintFinding[] });
  }
  return out;
}

/** The block address a node id ends with: `estate/aws_db_instance.orders` -> `aws_db_instance.orders`. */
const address = (id: string): string => id.slice(id.lastIndexOf("/") + 1);

/**
 * The note's lint clause: how many errors lint found in the estate and on
 * which blocks, or nothing when it found none or was not asked. Read from the
 * cards, so it survives composition, and from `meta.lint` when the read
 * still has it, so an error that names no node is counted too.
 *
 * `3 lint errors, drawn anyway — TF030 aws_vpc_security_group_ingress_rule.bastion_ssh, TF033 aws_db_instance.orders, TF022 aws_db_instance.orders`
 */
export function terraformLintNote(ir: Pick<GraphIR, "nodes" | "meta">): { note?: string; noteShort?: string } {
  const cards = cardFindings(ir);
  const onCards = cards.reduce((n, c) => n + c.findings.length, 0);
  const total = Math.max(lintReportOf(ir)?.errors ?? 0, onCards);
  if (total === 0) return {};
  const where = cards.flatMap((c) => c.findings.map((f) => `${f.ruleId} ${address(c.id)}`));
  const elsewhere = total - onCards;
  if (elsewhere > 0) where.push(`${elsewhere} on no drawn block`);
  const count = `${total} lint error${total === 1 ? "" : "s"}`;
  return { note: `${count}, drawn anyway — ${where.join(", ")}`, noteShort: count };
}
