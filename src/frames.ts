/**
 * Deployment lanes (#5) — the temporal projection. behold captures a frame (the
 * current graph IR + a timestamp) as the estate changes, into a rolling buffer.
 * The lanes view morphs the graph between those keyframes (pinhole's frame morph,
 * #81) driven by a playhead; each frame is drawn at its real capture time, so the
 * filmstrip is honest about cadence — no interpolation.
 */
import type { GraphIR } from "@intentius/chant";

export interface Frame {
  id: string;
  /** Capture time (ms since epoch). */
  t: number;
  /** Fingerprint used to skip consecutive identical captures. */
  digest: string;
  ir: GraphIR;
}

/** Per-frame summary for the lanes strip — counts per substrate (lexicon). */
export interface FrameSummary {
  id: string;
  t: number;
  nodes: number;
  edges: number;
  byLexicon: Record<string, number>;
}

/** A frame's fingerprint: nodes (id+kind+drift status) and edges, sorted. Two
 * captures with the same digest are the same graph state, so we don't store a
 * duplicate keyframe. */
export function frameDigest(ir: GraphIR): string {
  const nodes = ir.nodes
    .map((n) => `${n.id}:${n.kind}:${(n.attrs as { _status?: string })?._status ?? ""}`)
    .sort();
  const edges = ir.edges.map((e) => `${e.from}>${e.to}`).sort();
  return `${nodes.join("|")}#${edges.join("|")}`;
}

/** A rolling buffer of captured frames (newest last). */
export class FrameBuffer {
  private frames: Frame[] = [];

  constructor(
    private readonly max = 100,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Capture `ir` as a frame. Skips (returns null) if identical to the last
   * frame's digest — only real state changes become keyframes. */
  capture(ir: GraphIR): Frame | null {
    const digest = frameDigest(ir);
    const last = this.frames[this.frames.length - 1];
    if (last && last.digest === digest) return null;
    const frame: Frame = { id: String(this.seq++), t: this.now(), digest, ir };
    this.frames.push(frame);
    if (this.frames.length > this.max) this.frames.shift();
    return frame;
  }

  private seq = 0;

  all(): Frame[] {
    return this.frames;
  }

  get size(): number {
    return this.frames.length;
  }

  summaries(): FrameSummary[] {
    return this.frames.map((f) => {
      const byLexicon: Record<string, number> = {};
      for (const n of f.ir.nodes) byLexicon[n.lexicon] = (byLexicon[n.lexicon] ?? 0) + 1;
      return { id: f.id, t: f.t, nodes: f.ir.nodes.length, edges: f.ir.edges.length, byLexicon };
    });
  }
}
