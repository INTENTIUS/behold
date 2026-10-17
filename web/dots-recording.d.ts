// Types for src/dots-preview.ts, which reads sources with the page's own reader (#712).
export function readCarve(text: string): any;
export function ownersAt(rec: any, upto: number, parents: Map<string, string>): Map<string, string>;
export function carveShow(rec: any, parents: Map<string, string>): any;
export function walkthroughShow(model: any): any;
export function ownersAtTime(show: any, t: number): Map<string, string>;
export function phaseAt(show: any, t: number): { id: string; t: number } | null;
