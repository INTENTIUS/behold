/**
 * Deployed CloudFormation stacks chant did not write (behold#1245).
 *
 * A `cloudformation` workspace member can name deployed stacks in a
 * `cloudformation-stacks.json` beside it, `{ "stacks": ["<name>"], "region":
 * "<region>" }` (INTENTIUS/chant#5455). chant's aws lexicon reads each stack's
 * processed template, resources and outputs, draws the template as nodes and
 * edges through the reader it already has for a template file, and says what
 * it found on the member graph's `meta.awsMember.stacks`. behold reads a
 * stack as it reads any chant workspace member: it parses no template and
 * invents no edge. What it adds is this one pass, which keeps chant's
 * per-stack answer visible on the cards:
 *
 *  - each resource of a read stack carries `attrs._stack`: the stack, its
 *    region and status, and the resource's physical id and status, as
 *    CloudFormation reported them;
 *  - a stack chant could not read is drawn as one neutral card, `UnreadStack`,
 *    with chant's reason in `_unobserved`. It is not absent (that would say
 *    the stack is not there) and it is not painted a colour (nothing was
 *    observed).
 *
 * Estate composition keeps nodes and drops `meta`, so the pass runs while the
 * ids are still the member's own, as the Terraform lint findings do
 * (src/terraform-lint.ts). It guards on the IR's content: an IR with no
 * `meta.awsMember.stacks` comes back untouched. Idempotent. Pure and
 * browser-safe: reads and annotates the IR it is handed.
 */
import type { GraphIR } from "@intentius/chant";

/** One resource of a deployed stack, as chant's `meta.awsMember.stacks[].resources` lists it. */
export interface DeployedStackResource {
  node: string;
  logicalId: string;
  type: string;
  physicalId?: string;
  status?: string;
}

/** One named stack, as chant's `meta.awsMember.stacks` lists it. */
export interface DeployedStackRead {
  name: string;
  region?: string;
  read: boolean;
  status?: string;
  reason?: string;
  resources: DeployedStackResource[];
  outputs: Record<string, string>;
}

/** What a card of a deployed stack carries on `attrs._stack`. */
export interface CardStack {
  name: string;
  region?: string;
  /** `StackStatus`, such as `UPDATE_COMPLETE`. */
  status?: string;
  physicalId?: string;
  /** The resource's own status, such as `CREATE_COMPLETE`. */
  resourceStatus?: string;
}

/** The kind of the card an unread stack is drawn as. */
export const UNREAD_STACK_KIND = "UnreadStack";

const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The stacks the IR's `meta.awsMember.stacks` lists, or undefined when chant wrote none. An entry without a name is dropped. */
export function deployedStacksOf(ir: Pick<GraphIR, "meta">): DeployedStackRead[] | undefined {
  const stacks = rec(rec(ir.meta)?.awsMember)?.stacks;
  if (!Array.isArray(stacks)) return undefined;
  const out: DeployedStackRead[] = [];
  for (const s of stacks) {
    const r = rec(s);
    const name = text(r?.name);
    if (!r || !name) continue;
    const outputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec(r.outputs) ?? {})) if (typeof v === "string") outputs[k] = v;
    out.push({
      name,
      ...(text(r.region) ? { region: text(r.region)! } : {}),
      read: r.read === true,
      ...(text(r.status) ? { status: text(r.status)! } : {}),
      ...(text(r.reason) ? { reason: text(r.reason)! } : {}),
      resources: (Array.isArray(r.resources) ? r.resources : [])
        .map(rec)
        .filter((x): x is Record<string, unknown> => !!x && typeof x.node === "string")
        .map((x) => ({
          node: x.node as string,
          logicalId: String(x.logicalId ?? ""),
          type: String(x.type ?? ""),
          ...(text(x.physicalId) ? { physicalId: text(x.physicalId)! } : {}),
          ...(text(x.status) ? { status: text(x.status)! } : {}),
        })),
      outputs,
    });
  }
  return out;
}

/** The id an unread stack's card has. */
export const unreadStackId = (name: string): string => `unread-stack/${name}`;

/**
 * Put chant's per-stack answer on the IR's cards, in place. `member` is the
 * workspace member's name. chant writes a resource's `node` as the member
 * IR's own id (`<member>/<LogicalId>`), so it is looked up as written; the
 * form with the member prefix stripped is only a fallback.
 */
export function attachDeployedStacks(ir: GraphIR, member: string): void {
  const stacks = deployedStacksOf(ir);
  if (!stacks) return;
  const prefix = `${member}/`;
  const own = (id: string): string => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  for (const stack of stacks) {
    if (!stack.read) {
      const id = unreadStackId(stack.name);
      const card = {
        id,
        kind: UNREAD_STACK_KIND,
        lexicon: "aws",
        attrs: {
          _status: "neutral",
          _unobserved: stack.reason ?? "chant did not say why the stack was not read",
          _stack: { name: stack.name, ...(stack.region ? { region: stack.region } : {}) } satisfies CardStack,
        },
      } as unknown as GraphIR["nodes"][number];
      const at = ir.nodes.findIndex((n) => n.id === id);
      if (at >= 0) ir.nodes[at] = card;
      else ir.nodes.push(card);
      continue;
    }
    for (const r of stack.resources) {
      const node = byId.get(r.node) ?? byId.get(own(r.node));
      if (!node) continue;
      const _stack: CardStack = {
        name: stack.name,
        ...(stack.region ? { region: stack.region } : {}),
        ...(stack.status ? { status: stack.status } : {}),
        ...(r.physicalId ? { physicalId: r.physicalId } : {}),
        ...(r.status ? { resourceStatus: r.status } : {}),
      };
      node.attrs = { ...node.attrs, _stack };
    }
  }
}

/** The stacks a card list holds that were not read, for a note: `name (reason)`. */
export function unreadStacks(ir: Pick<GraphIR, "nodes">): { name: string; reason: string }[] {
  const out: { name: string; reason: string }[] = [];
  for (const n of ir.nodes) {
    if (n.kind !== UNREAD_STACK_KIND) continue;
    const a = n.attrs as Record<string, unknown> | undefined;
    const stack = rec(a?._stack);
    out.push({ name: String(stack?.name ?? n.id), reason: String(a?._unobserved ?? "") });
  }
  return out;
}
