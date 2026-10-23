// Types for src/view-move.ts, which settles an agent's view with the same checks the URL uses (#914).
export type Refusal = { key: string; value: unknown; reason: string };
export type Want = Record<string, unknown>;
export const VIEW_KEYS: string[];
export const ZOOMS: string[];
export const LENSES: string[];
export const QUERY_MAX: number;
export function isEnvName(env: unknown): boolean;
export function checkQuery(v: unknown): { ok: true; value: string | null } | { ok: false; reason: string };
export function checkSnapshot(v: unknown): { ok: true; value: string | null } | { ok: false; reason: string };
export function readViewQuery(search: string): Want;
export function writeViewQuery(search: string, state: Want, defaults?: { env?: string | null; lens?: string }): string;
export function settleView(want: Want, offer: { zooms?: string[]; envs?: string[]; tiers?: string[]; lenses?: string[]; env?: string | null }): { apply: Want; refused: Refusal[] };
export function viewFromObject(d: unknown): { want: Want; refused: Refusal[] };
export function refusalLine(refused: Refusal[]): string;
