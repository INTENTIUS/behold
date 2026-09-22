// A uniform grid over dot centres, for hit testing a renderer the DOM cannot
// see into (#457). Cell size is a few dot radii, so a query looks at the 3x3
// cells around the pointer and returns the nearest dot whose disc contains it.

export class GridIndex {
  constructor(state) { this.rebuild(state); }

  rebuild(state) {
    this.cell = Math.max(4, state.r * 4);
    this.cols = Math.ceil(state.w / this.cell) + 1;
    this.rows = Math.ceil(state.h / this.cell) + 1;
    const buckets = new Map();
    for (let i = 0; i < state.n; i++) {
      const k = this.key(state.x[i], state.y[i]);
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(i);
    }
    this.buckets = buckets;
  }

  key(x, y) {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
    return cy * this.cols + cx;
  }

  nearest(state, x, y) {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    let best = -1;
    let bestD = state.r * state.r;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const b = this.buckets.get((cy + dy) * this.cols + (cx + dx));
        if (!b) continue;
        for (const i of b) {
          const ex = state.x[i] - x;
          const ey = state.y[i] - y;
          const d = ex * ex + ey * ey;
          if (d <= bestD) { bestD = d; best = i; }
        }
      }
    }
    return best;
  }
}
