/**
 * The pieces of behold the action needs, over the `behold graph` command of an
 * installed @intentius/behold. Nothing is imported from the package: each call
 * runs its bin, so any release that has `behold graph --changed` works.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Characters a whole comment may hold, as FORGE_BUDGETS holds them in behold. GitHub accepted 262,144 in the live check (behold#1065); the other forges keep the lower figure. */
export const COMMENT_CHARS = { gitlab: 60_000, github: 262_144, forgejo: 60_000 };
export const FORGE_BUDGETS = Object.fromEntries(Object.entries(COMMENT_CHARS).map(([k, v]) => [k, { commentChars: v }]));

const cell = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/`/g, "'");

function classOf(n) {
  return n.diff ?? (n.change === "create" || n.change === "added" ? "added" : n.change === "delete" || n.change === "removed" ? "removed" : n.change ? "changed" : undefined);
}

/** A per-root table in Markdown: one row per root with its cards and, for a changed cut, its added, changed and removed counts. */
export function rootTable(doc, maxChars = Infinity) {
  const groups = new Map(doc.groups.map((g) => [g.id, g]));
  const byBox = new Map();
  for (const g of doc.groups) {
    let at = g;
    for (let guard = 0; at.parent !== undefined && groups.has(at.parent) && guard <= doc.groups.length; guard++) at = groups.get(at.parent);
    byBox.set(g.id, at.title);
  }
  const rows = new Map();
  let anyChange = false;
  for (const n of doc.nodes) {
    const key = n.detail__root ?? (n.box !== undefined ? byBox.get(n.box) : undefined) ?? n.detail__member ?? "(no root)";
    const r = rows.get(key) ?? { cards: 0, added: 0, changed: 0, removed: 0 };
    r.cards++;
    const c = classOf(n);
    if (c === "added" || c === "changed" || c === "removed") {
      r[c]++;
      anyChange = true;
    }
    rows.set(key, r);
  }
  const sorted = [...rows.entries()].sort(([ka, a], [kb, b]) => b.added + b.changed + b.removed - (a.added + a.changed + a.removed) || b.cards - a.cards || (ka < kb ? -1 : ka > kb ? 1 : 0));
  const head = anyChange ? "| Root | Cards | Added | Changed | Removed |\n| --- | ---: | ---: | ---: | ---: |\n" : "| Root | Cards |\n| --- | ---: |\n";
  const line = ([k, r]) => (anyChange ? `| ${cell(k)} | ${r.cards} | ${r.added} | ${r.changed} | ${r.removed} |\n` : `| ${cell(k)} | ${r.cards} |\n`);
  let out = head;
  for (let i = 0; i < sorted.length; i++) {
    const more = sorted.length - i;
    const tail = `\n${more} more ${more === 1 ? "root" : "roots"} not listed.\n`;
    const next = line(sorted[i]);
    if (out.length + next.length + (i + 1 < sorted.length ? tail.length : 0) > maxChars) return `${out}${tail}`;
    out += next;
  }
  return out;
}

export function checkGraphDocument(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "not a behold graph document: not a JSON object" };
  if (value.schema !== "behold-graph/1") return { ok: false, error: `not a behold-graph/1 document: schema is ${JSON.stringify(value.schema)}` };
  for (const list of ["nodes", "edges", "groups", "notes"]) if (!Array.isArray(value[list])) return { ok: false, error: `behold-graph/1 document without a \`${list}\` list` };
  return { ok: true, document: value };
}

export function gitRoot(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${dir} is not inside a git repository: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/**
 * An object shaped like the behold module the action's code reads, over the
 * bin at `bin`. `useCut` says which cut `forgeComment` draws.
 */
export function cliBehold({ bin, version }) {
  let cut = { dir: ".", args: [] };
  const run = (argv) => spawnSync(process.execPath, [bin, "graph", ...argv], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return {
    version,
    FORGE_BUDGETS,
    gitRoot,
    checkGraphDocument,
    rootTable,
    useCut(c) {
      cut = c;
    },
    async runGraph(argv, io) {
      const r = run(argv);
      if (r.stdout) io.stdout(r.stdout);
      if (r.stderr) io.stderr(r.stderr);
      return r.status ?? 3;
    },
    /** The comment's diagram from `behold graph --mermaid --forge`, which fits the forge's block budget; `table` when it had to leave cards out. */
    forgeComment(doc, { forge, marker }) {
      const r = run([cut.dir, ...cut.args, "--mermaid", "--forge", forge]);
      if (r.status !== 0) return { kind: "table", text: "", hidden: doc.nodes.length };
      const hidden = /\["\d+ cards? not shown"\]/.test(r.stdout) ? 1 : 0;
      const text = `<!-- ${marker} -->\n\n\`\`\`mermaid\n${r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`}\`\`\`\n`;
      return hidden === 0 ? { kind: "diagram", text, hidden } : { kind: "table", text: "", hidden };
    },
  };
}

export function readVersion(pkgDir) {
  return JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
}
