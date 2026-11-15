// Types for neighbourhood.js, a copy of behold's web/neighbourhood.js.
export interface Identity {
  group?: string;
  kind?: string;
  namespace?: string;
  name?: string;
}
export function neighbourhoodOf(
  graph: { nodes: any[]; edges: any[]; groups?: unknown },
  identity: Identity,
  opts?: { depth?: number; outside?: number; up?: boolean; down?: boolean }
): { nodes: any[]; edges: any[]; groups: any; seeds: string[]; reason?: string };
