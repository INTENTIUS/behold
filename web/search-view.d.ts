// Types for src/count-by-plan.test.ts, which holds the page's drawing of a search answer to chant's document (behold#913, #922).
export interface Counts {
  by: string;
  total: number;
  groups: Array<{ group: string; count: number; ids: string[] | null }>;
}
export interface GroupMark {
  group: string;
  count: number;
  colour: string;
  drawn: string[];
  label: string | null;
  ids: string[] | null;
}
export const GROUP_COLOURS: string[];
export function searchUrl(view: Record<string, unknown>): string;
export function searchKey(view: Record<string, unknown>): string | null;
export function queryMarks(
  answer: unknown,
  cards: Set<string> | string[],
  edges: Array<{ from: string; to: string }>,
): { cardMarks: Map<string, string>; near: Map<string, string>; unobserved: Set<string>; edgeMarks: Array<string | null>; state: string; litDrawn: number; litTotal: number };
export function groupMarks(answer: unknown, cards: Set<string> | string[]): { groups: GroupMark[]; cardGroup: Map<string, number>; total: number; by: string };
export function groupLabel(g: { group: string; count: number }): string;
export function countsLine(counts: Counts | null | undefined): string;
export function queryLine(view: Record<string, unknown>, answer: unknown, marks?: unknown): { text: string; tone: string; notSearched: string };
export function uncapturedLine(q: string, queries: unknown[]): string;
