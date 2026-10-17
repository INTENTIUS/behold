// The dots preview (#712, after #457 and #462): a local-only server mode that
// draws a real recording as cards, then dots, then estate discs, and replays
// it. `npm run preview:dots` starts it (scripts/dots-preview.ts). Nothing here
// is reachable from `behold serve`: the routes exist only when createApp is
// given `dotsPreview`, and the page draws its canvas only when /api/graph's
// meta carries `dots`.
//
// Two sources, both committed and both real:
//   carve:<name>  a carve recording in scripts/dot-bench/ (#457's terralith-14
//                 carve, 1,041 resources, 463 moves into eight estates);
//   terralith     the terralith walkthrough's snapshots
//                 (src/__fixtures__/terralith, 23 resources over four phases).
//
// The card graph is one Terraform member named after the source estate, one
// node per resource, id `<estate>/<address>`.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, basename } from "node:path";
import type { Hono } from "hono";
import type { GraphIR, IRNode } from "@intentius/chant";
import { renderGrid } from "./render.ts";
import { readTerralith } from "./terralith-demo.ts";
// The page's own readers, so the server's card order and the page's dots agree.
import { readCarve, carveShow, walkthroughShow } from "../web/dots-recording.js";
import { parentsOf, unitsOf } from "../web/dots-layout.js";

export interface DotsPreviewOptions {
  /** Directory holding carve recordings (`*.jsonl` or `*.jsonl.gz`). */
  recordings: string;
  /** The terralith walkthrough's snapshot root (holds `snapshots/` and `split.json`). */
  walkthrough: string;
}

export const DEFAULT_DOTS_SOURCE = "carve:carve-terralith-14";

/** The recordings a preview can play, by name (file name without `.jsonl[.gz]`). */
export function listRecordings(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.jsonl(\.gz)?$/.test(f))
    .map((f) => f.replace(/\.jsonl(\.gz)?$/, ""))
    .sort();
}

/** A source name -> what the page reads. Only names in the list are served; no path is taken from the caller. */
export function readDotsSource(opts: DotsPreviewOptions, name: string): { kind: "carve"; name: string; text: string } | { kind: "walkthrough"; name: string; model: unknown } {
  if (name === "terralith") return { kind: "walkthrough", name, model: readTerralith(opts.walkthrough) };
  const m = /^carve:([\w.-]+)$/.exec(name);
  const wanted = m ? basename(m[1]) : "";
  if (!m || !listRecordings(opts.recordings).includes(wanted)) {
    throw new Error(`no dots source named ${JSON.stringify(name)}: the sources are terralith and ${listRecordings(opts.recordings).map((r) => `carve:${r}`).join(", ")}`);
  }
  const gz = join(opts.recordings, `${wanted}.jsonl.gz`);
  const text = existsSync(gz) ? gunzipSync(readFileSync(gz)).toString("utf8") : readFileSync(join(opts.recordings, `${wanted}.jsonl`), "utf8");
  return { kind: "carve", name, text };
}

interface ShowLike {
  source: string;
  roster: Array<{ address: string; type: string; taggable: boolean; rung?: string }>;
}

/** The show a source makes, read the way the page reads it. */
export function showOf(src: ReturnType<typeof readDotsSource>): ShowLike {
  if (src.kind === "walkthrough") return walkthroughShow(src.model) as ShowLike;
  const rec = readCarve(src.text);
  return carveShow(rec, parentsOf(rec.roster)) as ShowLike;
}

/** The card IR: one Terraform member named after the source estate, its nodes in unit order. */
export function dotsIr(show: ShowLike): { ir: GraphIR; order: string[] } {
  const member = show.source;
  const units = unitsOf(show.roster) as Array<{ anchor: { address: string }; others: Array<{ address: string }>; children: Array<{ address: string }> }>;
  const order = units.flatMap((u) => [u.anchor, ...u.others, ...u.children]).map((m) => `${member}/${m.address}`);
  const byAddr = new Map(show.roster.map((r) => [r.address, r]));
  const nodes: IRNode[] = order.map((id) => {
    const r = byAddr.get(id.slice(member.length + 1))!;
    // A Terraform resource card as the terraform lens leaves one: its block and address.
    return { id, kind: r.type, lexicon: "terraform", attrs: { block: "resource", address: r.address, ...(r.rung ? { rung: r.rung } : { taggable: r.taggable }) } };
  });
  const ir = { version: 1, nodes, edges: [], groups: { byStack: { [member]: order } } } as unknown as GraphIR;
  return { ir, order };
}

export function dotsPreviewRoutes(app: Hono, opts: DotsPreviewOptions): void {
  const cache = new Map<string, { ir: GraphIR; svg: string; count: number; kind: string }>();
  const graphOf = (name: string) => {
    const hit = cache.get(name);
    if (hit) return hit;
    const src = readDotsSource(opts, name);
    const show = showOf(src);
    const { ir, order } = dotsIr(show);
    const { svg } = renderGrid(ir, order, show.source);
    const out = { ir, svg, count: order.length, kind: src.kind };
    cache.set(name, out);
    return out;
  };
  app.get("/api/dots/sources", (c) => c.json({ default: DEFAULT_DOTS_SOURCE, sources: ["terralith", ...listRecordings(opts.recordings).map((r) => `carve:${r}`)] }));
  app.get("/api/dots/source", (c) => {
    try {
      return c.json(readDotsSource(opts, c.req.query("name") ?? DEFAULT_DOTS_SOURCE));
    } catch (err) {
      return c.json({ error: (err as Error).message, code: "dots-source" }, 404);
    }
  });
  app.get("/api/graph", (c) => {
    const name = c.req.query("dots") ?? DEFAULT_DOTS_SOURCE;
    try {
      const g = graphOf(name);
      return c.json({
        ir: g.ir,
        svg: g.svg,
        meta: {
          projectDir: name,
          env: null,
          tier: null,
          target: null,
          dots: { source: name, kind: g.kind },
          note: `dots preview: ${name}, ${g.count} resources. Zoom out past the fit (pinch or ⌘-scroll) or use the rail.`,
        },
      });
    } catch (err) {
      return c.json({ error: (err as Error).message, code: "dots-source", remedy: "open /?dots=carve:carve-terralith-14 or /?dots=terralith" }, 404);
    }
  });
  app.get("/api/project", (c) =>
    c.json({
      projectDir: "dots preview",
      recents: [],
      environments: [],
      lexicons: ["terraform"],
      currentEnv: null,
      targets: [],
      dotsPreview: true,
    }),
  );
  // The page itself is behold's own index.html; a bare `/` opens the default source.
  app.get("/", async (c, next) => {
    if (new URL(c.req.url).searchParams.has("dots")) return next();
    return c.redirect(`/?dots=${DEFAULT_DOTS_SOURCE}`);
  });
}
