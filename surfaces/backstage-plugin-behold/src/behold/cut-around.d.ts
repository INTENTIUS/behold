// Types for web/cut-around.js, for the TypeScript that wraps it (src/graph-cut.ts, #1067).

export interface CutGraph {
  nodes: Array<{ id: string }>;
  edges: Array<{ from: string; to: string }>;
  groups?: unknown;
}

export interface CutAroundOptions {
  depth?: number;
  up?: boolean;
  down?: boolean;
  outside?: number;
  inside?: ((node: any) => boolean) | null;
}

export interface CutAroundResult<N, E> {
  nodes: N[];
  edges: E[];
  groups: Record<string, Record<string, string[]>>;
  seeds: string[];
  missing?: string[];
  reason?: string;
}

export function cutAround<N extends { id: string }, E extends { from: string; to: string }>(
  graph: { nodes: N[]; edges: E[]; groups?: unknown },
  startIds: readonly string[],
  opts?: CutAroundOptions,
): CutAroundResult<N, E>;
