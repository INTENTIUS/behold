// Types for src/dots-preview.ts, which orders the cards with the page's own layout (#712).
export function parseAddress(address: string): { module: string; type: string; name: string; index: string };
export function unitOf(address: string, type?: string): string;
export function unitsOf(roster: Array<{ address: string; type: string; taggable: boolean }>): any[];
export function parentsOf(roster: Array<{ address: string; type: string; taggable: boolean }>): Map<string, string>;
export function ringsOf(n: number, start?: number): Array<{ r: number; n: number }>;
export function unitCell(u: any): { rings: Array<{ r: number; n: number }>; shift: number; cell: number };
export function blockWidth(units: any[], aspect?: number): number;
export function packBlock(units: any[], opts?: { width?: number; fromEnd?: boolean }): any;
export function shelfPack(boxes: Array<{ key: string; w: number; h: number }>, opts: { width: number; gap?: number }): Map<string, { x: number; y: number }>;
