// Types for outside-refs.js, a copy of behold's web/outside-refs.js.
export interface OutsideCard {
  id: string;
  kind: string;
  label: string;
  attrs: Record<string, any>;
  placeholder: true;
}
export interface OutsideEdge {
  from: string;
  fromRef?: { group: string; kind: string; namespace: string; name: string };
  to: string;
  kind: string;
  viaAttr: string;
  revision?: string;
  inferred: true;
  placeholder: true;
}
export interface OutsideNote {
  code: string;
  from: string;
  path: string;
  message: string;
  waitsOn?: string;
}
export function outsideRefs(
  objects: any[],
  opts?: { graph?: { nodes: any[] } }
): { cards: OutsideCard[]; edges: OutsideEdge[]; notes: OutsideNote[] };
