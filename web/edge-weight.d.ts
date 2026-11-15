// Types for src/stack-lens.ts, which keeps the traffic path's lines when a card carries a count instead (#877), and src/catalog-draw.ts (#1080).
export const WEIGHTS: Record<string, string>;
export const CATALOG_WEIGHTS: string[];
export function isWired(e: { viaAttr?: string }): boolean;
export function isCatalogEdge(e: { origin?: string; rule?: string; relation?: string }, rules?: Record<string, unknown>): boolean;
export function edgeWeights(
  edges?: Array<{ from: string; to: string; kind?: string; viaAttr?: string; inferred?: boolean; origin?: string; rule?: string; relation?: string; dangling?: boolean; ambiguous?: unknown }>,
  kindOf?: Map<string, string | undefined>,
  rules?: Record<string, unknown>,
): Map<string, string>;
export function weightLegend(weights: Map<string, string>): Array<{ weight: string; label: string; title: string; count: number }>;
