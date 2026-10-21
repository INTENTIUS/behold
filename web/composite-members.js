// behold#828: a composites-zoom card's member list. The inspect pane derives it
// from the attribute-tier graph, where every member carries its
// `compositeInstance` and `compositeParent`. chant keys a collapsed composite by
// its instance name, and when two composites share that name (an AWS
// FargateAlb and a GCP CloudRunServiceComposite both exported as `web`) it
// names them `<instance>@<CompositeType>` (chant#4178). So each member is
// listed under both keys, and a card finds its own members whichever id it has.
//
// Pure logic, no DOM.

/** Member lists by composite id: `<instance>` and `<instance>@<compositeParent>`. */
export function indexCompositeMembers(nodes) {
  const out = {};
  for (const n of nodes || []) {
    if (!n.compositeInstance) continue;
    const member = { id: n.id, kind: n.kind };
    (out[n.compositeInstance] ||= []).push(member);
    if (n.compositeParent) (out[`${n.compositeInstance}@${n.compositeParent}`] ||= []).push(member);
  }
  return out;
}
