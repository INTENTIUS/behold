/**
 * #996 (B3): `count` and `for_each` instances drawn as cards of their own,
 * each with its own plan and drift, beside the block card they belong to.
 *
 * The id rule is the one chant's graph IR uses for an instance node
 * (INTENTIUS/chant#4454, C4): the block's node id followed by the instance
 * key exactly as Terraform prints it, `<blockNode>[0]`, `<blockNode>["a"]`;
 * on an estate `<member>/<blockNode>[0]`, since composition prefixes the
 * block's id. The block card stays and is the rollup: its `_plan` is chant's
 * aggregate over the instances, and it lists its instance cards in
 * `attrs._instances`.
 *
 * Two sources give instances, and both land on the same ids:
 *
 * - chant's graph, once it emits instance nodes as children of the block
 *   node (C4, a field naming the parent block, `instanceOf`). Those nodes are
 *   kept as chant drew them; this module only gives one its own plan facts
 *   when chant's plan read put them on the block instead.
 * - the plan read on a stock Terraform root (src/terraform-plan.ts), which
 *   behold already gets per instance: `planActions` is keyed by instance
 *   address, and each change and drift row names its `instance`
 *   (chant's `planAttributesFor`, lexicons/terraform/src/plan-observation.ts).
 *   Until chant emits instance nodes, the cards are derived from those rows.
 *
 * A choudoufu member's roster is per instance already (src/choudoufu-member.ts
 * `liveCheckToIr`, one card per `live-check` address, painted by `live-ls`
 * and `live-plan` on its own), so its cards are left as they are.
 *
 * Under an expanded module call (INTENTIUS/chant#4486 planned, chant#4488
 * live) the module key goes on the call segment it belongs to and the
 * block's own key stays at the end: `module.app[0].aws_eip.pool[1]` in root
 * `estate` is `estate/module.app[0]/aws_eip.pool[1]`, under the block node
 * `estate/module.app/aws_eip.pool`. Such a node carries `instanceScope`, the
 * expanded module path (`module.app[0]`), and its `instanceKey` is absent when
 * only the module call is expanded. A chant that predates the rule drew no
 * node for these and rolled their entries up to the block; behold reads both
 * fields when present (optional reads: chant 0.124.52's `IRNode` has no
 * `instanceScope`) and draws plan-derived cards for module-keyed instances by
 * the same rule, so an old chant's plan and a new chant's graph land on the
 * same ids.
 */
import type { GraphIR, IRNode } from "@intentius/chant";
import { TERRAFORM_LEXICON } from "./terraform-lens.ts";
import type { PlanCardFacts } from "./terraform-plan.ts";

/** One instance key as Terraform prints it: `[0]`, `["a"]` (a quoted key may hold `]` or `\"`). */
const KEY = /\[(?:\d+|"(?:[^"\\]|\\.)*")\]/g;
/** The key at the very end of an address or id. */
const TRAILING_KEY = /\[(?:\d+|"(?:[^"\\]|\\.)*")\]$/;

/** The parent-block field chant's instance nodes carry (C4). Read on the node and in its attrs. */
export const INSTANCE_OF = "instanceOf";

/**
 * The resource's own instance key of an address, or undefined when the
 * address has none or also carries a module instance key (that one stays in
 * the rollup, see the module comment). `aws_s3_bucket.b[2]` -> `[2]`.
 */
export function instanceKeyOf(address: string): string | undefined {
  const keys = address.match(KEY);
  if (!keys || keys.length !== 1) return undefined;
  const m = TRAILING_KEY.exec(address);
  return m ? m[0] : undefined;
}

/** The instance node id: the block's node id and the key, nothing between. */
export const instanceNodeId = (blockNode: string, key: string): string => `${blockNode}${key}`;

/**
 * Split an entry's graph node into the instance node and its block, by the
 * id rule. `node` is what chant mapped the entry to: the block node today,
 * the instance node once C4 lands. Either way the answer is the same pair, so
 * a change set stored before C4 and one stored after outline the same cards.
 * Undefined when the address is not one instance of a counted block.
 */
export function instanceOfNode(node: string, address: string): { instance: string; block: string; key: string } | undefined {
  const key = instanceKeyOf(address);
  if (!key) return undefined;
  if (node.endsWith(key) && node.length > key.length) return { instance: node, block: node.slice(0, -key.length), key };
  return { instance: instanceNodeId(node, key), block: node, key };
}

/** One part of a terraform address: a name and the `[...]` key that follows it, if any. */
interface AddressPart {
  name: string;
  key?: string;
}

/** Split a terraform address on its dots, keeping each part's `[...]` key. Quoted keys may hold `.` or `]`. chant's `addressParts` (instance-nodes.ts). */
function addressParts(address: string): AddressPart[] {
  const parts: AddressPart[] = [];
  let name = "";
  let key = "";
  let depth = 0;
  let quoted = false;
  const flush = (): void => {
    if (name.length > 0) parts.push({ name, ...(key ? { key } : {}) });
    name = "";
    key = "";
  };
  for (let i = 0; i < address.length; i++) {
    const c = address[i]!;
    if (depth > 0) {
      key += c;
      if (quoted) {
        if (c === "\\") key += address[++i] ?? "";
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "]") depth--;
      continue;
    }
    if (c === "[") {
      depth++;
      key += c;
    } else if (c === ".") flush();
    else name += c;
  }
  flush();
  return parts;
}

/** Where a module-keyed instance address sits relative to its root (chant#4486's `terraformInstancePath`). */
export interface ScopedInstancePath {
  /** The block's key in its root: `module.app/aws_eip.pool`. */
  block: string;
  /** The instance node's key in its root: `module.app[0]/aws_eip.pool[1]`. */
  instance: string;
  /** The block's own key, `[1]`, absent when only the module call is expanded. */
  key?: string;
  /** The expanded module path, `module.app[0]`. */
  scope: string;
}

/**
 * The block key and instance key of an address under an expanded module
 * call, by chant#4486's rule. Undefined when no module call on the way is
 * expanded (the plain `<block>[key]` rule covers that) or the address is not
 * a block's. Mirrors chant's `terraformInstancePath`, which chant 0.124.52
 * does not export.
 */
export function scopedInstancePath(address: string): ScopedInstancePath | undefined {
  const parts = addressParts(address);
  const blockScope: string[] = [];
  const instanceScope: string[] = [];
  let i = 0;
  while (parts[i]?.name === "module" && i + 1 < parts.length) {
    const call = parts[i + 1]!;
    blockScope.push(`module.${call.name}`);
    instanceScope.push(`module.${call.name}${call.key ?? ""}`);
    i += 2;
  }
  const rest = parts.slice(i);
  let block: string;
  let key: string | undefined;
  if (rest.length === 0) {
    // The module call itself, a block of its caller.
    if (blockScope.length === 0) return undefined;
    const call = blockScope.pop()!;
    const inst = instanceScope.pop()!;
    block = call;
    key = inst.length > call.length ? inst.slice(call.length) : undefined;
  } else if (rest[0]!.name === "data" && rest.length >= 3) {
    block = `data.${rest[1]!.name}.${rest[2]!.name}`;
    key = rest[2]!.key;
  } else if (rest.length >= 2) {
    block = `${rest[0]!.name}.${rest[1]!.name}`;
    key = rest[1]!.key;
  } else return undefined;
  if (!instanceScope.some((s, n) => s !== blockScope[n])) return undefined;
  return {
    block: [...blockScope, block].join("/"),
    instance: [...instanceScope, `${block}${key ?? ""}`].join("/"),
    ...(key !== undefined ? { key } : {}),
    scope: instanceScope.join("."),
  };
}

/** The instance node id of a module-keyed address under the block node `blockNode`, or undefined when the address is not that block's. */
export function scopedInstanceNodeId(blockNode: string, address: string): string | undefined {
  const path = scopedInstancePath(address);
  if (!path) return undefined;
  if (blockNode !== path.block && !blockNode.endsWith(`/${path.block}`)) return undefined;
  return `${blockNode.slice(0, blockNode.length - path.block.length)}${path.instance}`;
}

/** A string field of a chant node, read on the node and in its attrs (chant puts the instance fields on the node; behold's derived cards put them in attrs). */
function nodeField(n: Pick<IRNode, "attrs">, field: string): string | undefined {
  const top = (n as unknown as Record<string, unknown>)[field];
  if (typeof top === "string" && top) return top;
  const inAttrs = n.attrs?.[field];
  return typeof inAttrs === "string" && inAttrs ? inAttrs : undefined;
}

/** The expanded module path an instance node sits under (chant#4486 `instanceScope`, `module.app[0]`), if any. */
export const instanceScopeOf = (n: Pick<IRNode, "attrs">): string | undefined => nodeField(n, "instanceScope");

/** The block's own instance key an instance node carries (`[1]`), absent when only its module call is expanded. */
export const ownInstanceKeyOf = (n: Pick<IRNode, "attrs">): string | undefined => nodeField(n, "instanceKey");

/**
 * The block node id an instance node belongs to, by the id rule, so it
 * survives composition (which prefixes ids and not `instanceOf`). Without a
 * scope: the id less its trailing key. With one: the scope's segment in the
 * id (`module.app[0]`) loses its keys (`module.app`) and the trailing key goes
 * only when the node has an `instanceKey`. Undefined when the id does not fit.
 */
export function instanceBlockIdOf(n: Pick<IRNode, "id" | "attrs">): string | undefined {
  const scope = instanceScopeOf(n);
  if (!scope) {
    const key = TRAILING_KEY.exec(n.id)?.[0];
    return key ? n.id.slice(0, -key.length) : undefined;
  }
  const parts = addressParts(scope);
  const keyed: string[] = [];
  const bare: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i]!.name !== "module") return undefined;
    keyed.push(`module.${parts[i + 1]!.name}${parts[i + 1]!.key ?? ""}`);
    bare.push(`module.${parts[i + 1]!.name}`);
  }
  if (!keyed.length) return undefined;
  const seg = `${keyed.join("/")}/`;
  const at = n.id.lastIndexOf(seg);
  if (at < 0 || (at > 0 && n.id[at - 1] !== "/")) return undefined;
  let tail = n.id.slice(at + seg.length);
  const key = ownInstanceKeyOf(n);
  if (key) {
    if (!tail.endsWith(key)) return undefined;
    tail = tail.slice(0, -key.length);
  }
  return `${n.id.slice(0, at)}${bare.join("/")}/${tail}`;
}

/** The parent block a chant instance node names, if it is one. */
export function instanceParentOf(n: Pick<IRNode, "attrs">): string | undefined {
  const top = (n as unknown as Record<string, unknown>)[INSTANCE_OF];
  if (typeof top === "string" && top) return top;
  const inAttrs = n.attrs?.[INSTANCE_OF];
  return typeof inAttrs === "string" && inAttrs ? inAttrs : undefined;
}

/** Terraform's action list as one word, the way chant's `actionWord` gives the block's. */
function actionWord(actions: readonly string[]): string {
  if (actions.includes("create") && actions.includes("delete")) return "replace";
  if (actions.length === 0) return "no-op";
  return actions.join(",");
}

/**
 * The block address a block card answers to: its lexicon `address`, else the
 * block key after its root in the id (`<root>/module.app/aws_s3_bucket.b` ->
 * `module.app.aws_s3_bucket.b`).
 */
function blockAddress(n: Pick<IRNode, "id" | "attrs">): string | undefined {
  if (typeof n.attrs?.address === "string" && n.attrs.address) return n.attrs.address;
  const root = n.attrs?.root;
  if (typeof root !== "string" || !root) return undefined;
  const at = n.id.indexOf(`${root}/`);
  return at === 0 || (at > 0 && n.id[at - 1] === "/") ? n.id.slice(at + root.length + 1).replace(/\//g, ".") : undefined;
}

/**
 * The plan facts of one instance, sliced out of its block's: the instance's
 * own action, and the change and drift rows that name it. What chant only
 * gives per block (the action reason, the replace paths, what stays unknown,
 * the relevant attributes) is not split, so it is not put on an instance:
 * the block card still carries it.
 */
export function instancePlanFacts(block: PlanCardFacts, instanceAddress: string): PlanCardFacts {
  if (block.source !== "plan") return { source: block.source, ...(block.note ? { note: block.note } : {}) };
  const actions = block.actions?.[instanceAddress];
  const facts: PlanCardFacts = { source: "plan", action: actions ? actionWord(actions) : "no-op" };
  if (actions) facts.actions = { [instanceAddress]: actions };
  const changes = block.changes?.filter((c) => c.instance === instanceAddress);
  if (changes?.length) facts.changes = changes;
  const drift = block.drift?.filter((d) => d.instance === instanceAddress);
  if (drift?.length) {
    facts.drift = drift;
    // The block's drift words cover every instance; one word is this one's too.
    if (block.driftAction && !block.driftAction.includes(",")) facts.driftAction = block.driftAction;
  }
  return facts;
}

/** Every instance address a block's plan facts name. */
function plannedInstances(facts: PlanCardFacts): string[] {
  const out = new Set<string>(Object.keys(facts.actions ?? {}));
  for (const c of facts.changes ?? []) if (c.instance) out.add(c.instance);
  for (const d of facts.drift ?? []) if (d.instance) out.add(d.instance);
  return [...out].sort();
}

/**
 * Draw each painted block's instances as cards of their own, in place, after
 * the plan read painted `_plan` (src/terraform-plan.ts `paintTerraformPlan`).
 * An instance node chant already drew is kept and only given its plan facts
 * if it has none; any other instance the plan names gets a derived card: the
 * block's kind, lexicon and attrs, the instance address, `instanceOf` naming
 * the block node, and its own `_plan`. Each instance card sits in every box
 * its block sits in and has one edge to the block (`viaAttr: "instance of"`).
 * The block keeps its rollup `_plan` and lists the cards in `_instances`.
 * Returns how many cards were added.
 */
export function addInstanceCards(ir: GraphIR): number {
  const byId = new Map(ir.nodes.map((n) => [n.id, n] as const));
  // The block each instance node chant drew belongs to, by the id rule
  // first (it survives composition, which prefixes ids and not attrs), then
  // `instanceOf` as chant wrote it.
  const drawnUnder = new Map<string, string[]>();
  for (const n of ir.nodes) {
    const parent = instanceParentOf(n);
    if (!parent) continue;
    const byRule = instanceBlockIdOf(n);
    const block = byRule && byId.has(byRule) ? byRule : byId.has(parent) ? parent : undefined;
    if (block) (drawnUnder.get(block) ?? drawnUnder.set(block, []).get(block)!).push(n.id);
  }
  const have = new Set(ir.edges.map((e) => `${e.from}\0${e.to}`));
  let added = 0;
  for (const block of [...ir.nodes]) {
    if (block.lexicon !== TERRAFORM_LEXICON || instanceParentOf(block)) continue;
    const facts = block.attrs?._plan as PlanCardFacts | undefined;
    const address = blockAddress(block);
    const ids = new Set(drawnUnder.get(block.id) ?? []);
    if (facts && address) {
      for (const inst of plannedInstances(facts)) {
        let id: string;
        let key: string | undefined;
        let scope: string | undefined;
        if (inst.startsWith(address) && instanceKeyOf(inst) === inst.slice(address.length)) {
          key = inst.slice(address.length);
          id = instanceNodeId(block.id, key);
        } else {
          // Under an expanded module call (chant#4486): the module key on its call segment.
          const path = scopedInstancePath(inst);
          const scoped = path ? scopedInstanceNodeId(block.id, inst) : undefined;
          if (!path || !scoped) continue;
          id = scoped;
          key = path.key;
          scope = path.scope;
        }
        const existing = byId.get(id);
        if (existing) {
          if (!existing.attrs?._plan) existing.attrs = { ...existing.attrs, _plan: instancePlanFacts(facts, inst) };
        } else {
          const { _plan: _p, _instances: _i, ...attrs } = block.attrs ?? {};
          const card = {
            id,
            kind: block.kind,
            lexicon: block.lexicon,
            attrs: {
              ...attrs,
              address: inst,
              ...(key !== undefined ? { instanceKey: key } : {}),
              ...(scope !== undefined ? { instanceScope: scope } : {}),
              [INSTANCE_OF]: block.id,
              _plan: instancePlanFacts(facts, inst),
            },
          } as IRNode;
          ir.nodes.push(card);
          byId.set(id, card);
          added++;
        }
        ids.add(id);
      }
    } else if (facts) {
      // A root the plan did not answer: chant's instance nodes say the same.
      for (const id of ids) {
        const n = byId.get(id)!;
        if (!n.attrs?._plan) n.attrs = { ...n.attrs, _plan: facts };
      }
    }
    if (!ids.size) continue;
    const instances = [...ids].sort();
    block.attrs = { ...block.attrs, _instances: instances };
    for (const id of instances) {
      if (have.has(`${id}\0${block.id}`)) continue;
      have.add(`${id}\0${block.id}`);
      ir.edges.push({ from: id, to: block.id, kind: "ref", viaAttr: "instance of" } as GraphIR["edges"][number]);
    }
    placeBeside(ir, block.id, instances);
  }
  return added;
}

/** Put each instance id in every box the block id is in, once. */
function placeBeside(ir: GraphIR, block: string, instances: string[]): void {
  for (const groups of Object.values(ir.groups ?? {}) as Array<Record<string, string[]> | undefined>) {
    if (!groups || typeof groups !== "object") continue;
    for (const ids of Object.values(groups)) {
      if (!Array.isArray(ids) || !ids.includes(block)) continue;
      for (const id of instances) if (!ids.includes(id)) ids.push(id);
    }
  }
}
