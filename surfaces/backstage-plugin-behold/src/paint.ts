// The tab's own drawing, for when no single-file viewer is there. It lays a
// cut out as boxes in a row, the cards of a box in a grid inside it, and the
// edges as straight lines, and returns SVG text. No layout engine: a cut is
// a root and its neighbours, a few dozen cards at most.
import type { GraphDocument } from './behold/graph-document';

const CARD_W = 210;
const CARD_H = 34;
const GAP = 10;
const PAD = 14;
const HEAD = 26;
const COLS = 2;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);

export interface Painted {
  svg: string;
  width: number;
  height: number;
  cards: number;
}

/** `paper` is the page's card colour, so lines behind a card do not show through it. */
export function paint(doc: GraphDocument, paper = 'transparent'): Painted {
  const someOutside = doc.nodes.some(n => n.seed !== true);
  const order = [...doc.groups.map(g => g.id), ''];
  const titles = new Map(doc.groups.map(g => [g.id, g.title]));
  const byBox = new Map<string, typeof doc.nodes>();
  for (const n of doc.nodes) {
    const k = n.box && titles.has(n.box) ? n.box : '';
    byBox.set(k, [...(byBox.get(k) ?? []), n]);
  }

  const pos = new Map<string, { x: number; y: number }>();
  const boxes: string[] = [];
  const cards: string[] = [];
  let x = 0;
  let tallest = 0;
  for (const id of order) {
    const members = byBox.get(id);
    if (!members?.length) continue;
    const left = x;
    const rows = Math.ceil(members.length / COLS);
    const w = PAD * 2 + COLS * CARD_W + (COLS - 1) * GAP;
    const h = HEAD + PAD + rows * CARD_H + (rows - 1) * GAP + PAD;
    tallest = Math.max(tallest, h);
    boxes.push(
      `<g><rect x="${left}" y="0" width="${w}" height="${h}" rx="8" fill="none" stroke="currentColor" stroke-opacity=".35"/>` +
        `<text x="${left + PAD}" y="18" font-size="12" font-weight="600" fill="currentColor">${esc(clip(titles.get(id) ?? 'Other', 34))}</text></g>`,
    );
    members.forEach((n, i) => {
      const cx = left + PAD + (i % COLS) * (CARD_W + GAP);
      const cy = HEAD + PAD + Math.floor(i / COLS) * (CARD_H + GAP);
      pos.set(n.id, { x: cx + CARD_W / 2, y: cy + CARD_H / 2 });
      const seed = someOutside && n.seed === true;
      cards.push(
        `<g><title>${esc(n.id)}</title><rect x="${cx}" y="${cy}" width="${CARD_W}" height="${CARD_H}" rx="5" ` +
          `fill="${paper}" stroke="currentColor" stroke-opacity="${seed ? '.9' : '.45'}" stroke-width="${seed ? 2 : 1}"/>` +
          `<text x="${cx + 8}" y="${cy + 14}" font-size="11" fill="currentColor">${esc(clip(n.title.split('/').pop() ?? n.title, 32))}</text>` +
          `<text x="${cx + 8}" y="${cy + 27}" font-size="9" fill="currentColor" fill-opacity=".65">${esc(clip(n.kind, 34))}</text></g>`,
      );
    });
    x += w + GAP * 3;
  }

  const lines = doc.edges
    .map(e => {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (!a || !b) return '';
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="currentColor" stroke-opacity="${e.inferred ? '.25' : '.4'}"${e.inferred ? ' stroke-dasharray="4 3"' : ''}/>`;
    })
    .join('');

  const width = Math.max(x - GAP * 3, 1);
  const height = Math.max(tallest, 1);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${width + 4} ${height + 4}" width="100%" role="img" aria-label="The cards of the cut and the edges between them" style="max-height:640px">` +
    `${boxes.join('')}${lines}${cards.join('')}</svg>`;
  return { svg, width, height, cards: pos.size };
}
