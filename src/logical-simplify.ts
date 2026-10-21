/**
 * Fewer boxes for a composed estate's logical zoom (behold#824).
 *
 * Each lens nests what its substrate nests, and on a multi-cloud workspace that
 * adds up: AWS account › VPC › public subnets › `aws · public` › the ALB is four
 * boxes around one card, and the innermost says nothing the subnet box hasn't.
 * Two passes take the redundant ones away, after the lenses have joined:
 *
 *  1. A component box named for a workspace member (`aws`, `gcp · global`)
 *     whose children are all cards is unwrapped into its parent. In a composed
 *     estate the member is already the cloud box around it, so the component
 *     box only repeats it.
 *  2. A box holding exactly one other box, and no cards, is merged with it,
 *     titled `outer › inner`, so resource group › VNet › subnet reads as one.
 *
 * Account boundaries (AWS account, Azure subscription, GCP project) and the
 * keys callers address boxes by (a Kubernetes namespace box, which
 * operator.ts marks) are never merged away. Cards are never moved out of the
 * box that holds them except into that box's parent in pass 1. Pure.
 */
import type { ByContainer } from "./logical.ts";

const BOUNDARY_RE = /^(AWS account|Azure subscription|GCP project)\b/;

export function simplifyNesting(byContainer: ByContainer, members: ReadonlySet<string>, keep: ReadonlySet<string> = new Set()): ByContainer {
  const out: ByContainer = {};
  for (const [k, v] of Object.entries(byContainer)) out[k] = [...v];
  const isBox = (id: string) => Object.prototype.hasOwnProperty.call(out, id);
  const parentOf = (id: string) => Object.keys(out).find((k) => out[k].includes(id));
  const fixed = (k: string) => BOUNDARY_RE.test(k) || keep.has(k);

  // 1. Unwrap member-named component boxes.
  for (const key of Object.keys(out)) {
    if (fixed(key)) continue;
    const member = key.split(" · ")[0];
    if (!members.has(member) || !out[key].every((c) => !isBox(c))) continue;
    const parent = parentOf(key);
    if (!parent) continue;
    const at = out[parent].indexOf(key);
    out[parent].splice(at, 1, ...out[key].filter((c) => !out[parent].includes(c)));
    delete out[key];
  }

  // 2. Merge single-box chains, outermost first, until none is left.
  for (let changed = true; changed; ) {
    changed = false;
    for (const key of Object.keys(out)) {
      const kids = out[key];
      if (!kids || kids.length !== 1 || !isBox(kids[0]) || fixed(key) || fixed(kids[0])) continue;
      const inner = kids[0];
      const merged = `${key} › ${inner}`;
      out[merged] = out[inner];
      delete out[inner];
      delete out[key];
      const parent = parentOf(key);
      if (parent) out[parent] = out[parent].map((c) => (c === key ? merged : c));
      changed = true;
      break;
    }
  }
  return out;
}

/** The workspace members of a composed IR: the `<member>/` prefixes its node
 * ids carry. Empty for a single project. */
export function memberPrefixes(nodes: ReadonlyArray<{ id: string }>): Set<string> {
  const out = new Set<string>();
  for (const n of nodes) {
    const slash = n.id.indexOf("/");
    if (slash > 0) out.add(n.id.slice(0, slash));
  }
  return out;
}
