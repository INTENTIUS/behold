// Types for scripts/ask-demo/narration.ts, which records a turn's `light` with the lighter the ask demo page uses (behold#1163).
export interface IrNodeLike {
  id: string;
  attrs?: { _stackOf?: Array<{ id?: unknown }> } & Record<string, unknown>;
}
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function cardIndex(nodes: readonly IrNodeLike[]): Map<string, string>;
export function lightKeys(answer: { keys?: readonly string[]; rows?: ReadonlyArray<Record<string, unknown>> }, cards: ReadonlyMap<string, string>): string[];
export function cardMarks(cardIds: Iterable<string>, lit: readonly string[]): Map<string, "lit" | "dim">;
export function edgeMark(marks: ReadonlyMap<string, string>, from: string, to: string): "path" | "dim" | null;
export function frameBox(boxes: readonly Box[], full: Box, opts?: { pad?: number; min?: number }): Box;
export function viewShare(box: Box, full: Box): number;
export function boxGap(a: Box, b: Box): number;
export function boxClusters(boxes: readonly Box[] | null | undefined, near: number): Box[][];
export function zoomFrame(boxes: readonly Box[] | null | undefined, full: Box, opts?: { pad?: number; min?: number; share?: number; near?: number }): Box;
export function clearKeyLight(svg: unknown): void;
export function applyKeyLight(svg: unknown, lit: readonly string[], opts?: { pulse?: boolean }): unknown[];
