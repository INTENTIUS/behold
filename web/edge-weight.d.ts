// Types for src/stack-lens.ts, which keeps the traffic path's lines when a card carries a count instead (#877).
export const WEIGHTS: Record<string, string>;
export function isWired(e: { viaAttr?: string }): boolean;
export function edgeWeights(edges?: Array<{ from: string; to: string; kind?: string; viaAttr?: string; inferred?: boolean; origin?: string }>, kindOf?: Map<string, string | undefined>): Map<string, string>;
export function weightLegend(weights: Map<string, string>): Array<{ weight: string; label: string; title: string; count: number }>;
