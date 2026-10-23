/**
 * Leave a sensitive variable's literal default out of a card's source text (#920).
 *
 * chant's terraform lexicon puts the HCL text of the file a block lives in on
 * each node's `source` attribute, and every node of a file carries the whole
 * file. A `variable` declared `sensitive = true` with a literal `default`
 * therefore had that default in every card of the file, in `/api/graph`, and in
 * an export. The variable's own node also carries the parsed block as `body`,
 * with the default as a value, so that is redacted too. The plan read (src/terraform-plan.ts, #910) already shows such a
 * value as `(sensitive)`; this does the same for the declared text.
 *
 * The redaction lives here and not in chant's lexicon because it has to hold
 * for whichever chant is installed beside behold, and it is applied to the IR
 * once, right after chant answers and before the member's cache, so no
 * response path can reach the unredacted text.
 *
 * It is a scanner over HCL, not a regex: it skips strings (with `${}`),
 * heredocs and comments, finds each top-level `variable` block, and inside it
 * the `sensitive` and `default` attributes. The default's whole expression is
 * replaced, whether it is a string, a number, a list or a map spanning lines.
 * Only a literal `sensitive = true` counts; anything else is left as written.
 */
import type { GraphIR } from "@intentius/chant";

export const SENSITIVE_PLACEHOLDER = "(sensitive)";

const WORD = /[A-Za-z_][A-Za-z0-9_-]*/y;
const HEREDOC = /<<-?([A-Za-z_][A-Za-z0-9_]*)[ \t]*\r?\n/y;

/** Index just past the string opened at `i` (a `"`), interpolations included. */
function skipString(t: string, i: number): number {
  i++;
  while (i < t.length) {
    const c = t[i];
    if (c === "\\") i += 2;
    else if (c === "$" && t[i + 1] === "$" && t[i + 2] === "{") i += 3;
    else if ((c === "$" || c === "%") && t[i + 1] === "{") i = skipBraces(t, i + 1);
    else if (c === '"') return i + 1;
    else i++;
  }
  return t.length;
}

/** Index just past the heredoc whose opener starts at `i`, or -1 when `i` is not one. */
function skipHeredoc(t: string, i: number): number {
  HEREDOC.lastIndex = i;
  const m = HEREDOC.exec(t);
  if (!m) return -1;
  let p = HEREDOC.lastIndex;
  while (p < t.length) {
    let e = t.indexOf("\n", p);
    if (e < 0) e = t.length;
    if (t.slice(p, e).trim() === m[1]) return e;
    p = e + 1;
  }
  return t.length;
}

/** Index just past a comment starting at `i`, or -1 when there is none. A line comment stops before its newline. */
function skipComment(t: string, i: number): number {
  if (t[i] === "#" || (t[i] === "/" && t[i + 1] === "/")) {
    const e = t.indexOf("\n", i);
    return e < 0 ? t.length : e;
  }
  if (t[i] === "/" && t[i + 1] === "*") {
    const e = t.indexOf("*/", i + 2);
    return e < 0 ? t.length : e + 2;
  }
  return -1;
}

/** Index just past the bracket group opened at `i` (`{`, `[` or `(`). */
function skipBraces(t: string, i: number): number {
  let depth = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === '"') { i = skipString(t, i); continue; }
    const h = c === "<" && t[i + 1] === "<" ? skipHeredoc(t, i) : -1;
    if (h >= 0) { i = h; continue; }
    const k = skipComment(t, i);
    if (k >= 0) { i = k; continue; }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return t.length;
}

/** End of the expression starting at `i`: the last token before a newline or comma outside brackets, or the block's closing brace. */
function valueEnd(t: string, i: number, limit: number): number {
  let last = i;
  while (i < limit) {
    const c = t[i];
    if (c === "\n" || c === ",") break;
    if (c === '"') { i = skipString(t, i); last = i; continue; }
    const h = c === "<" && t[i + 1] === "<" ? skipHeredoc(t, i) : -1;
    if (h >= 0) { i = h; last = i; continue; }
    const k = skipComment(t, i);
    if (k >= 0) { i = k; continue; }
    if (c === "{" || c === "[" || c === "(") { i = skipBraces(t, i); last = i; continue; }
    if (c !== " " && c !== "\t" && c !== "\r") last = i + 1;
    i++;
  }
  return Math.min(last, limit);
}

interface Attr {
  name: string;
  from: number;
  to: number;
}

/** The attributes written directly in a block body spanning [from, to). */
function attributes(t: string, from: number, to: number): Attr[] {
  const out: Attr[] = [];
  let i = from;
  while (i < to) {
    const c = t[i];
    if (c === '"') { i = skipString(t, i); continue; }
    const k = skipComment(t, i);
    if (k >= 0) { i = k; continue; }
    if (c === "{" || c === "[" || c === "(") { i = skipBraces(t, i); continue; }
    WORD.lastIndex = i;
    const m = WORD.exec(t);
    if (!m) { i++; continue; }
    i = WORD.lastIndex;
    let p = i;
    while (t[p] === " " || t[p] === "\t") p++;
    if (t[p] === "=" && t[p + 1] !== "=" && t[p + 1] !== ">") {
      p++;
      while (t[p] === " " || t[p] === "\t") p++;
      const end = valueEnd(t, p, to);
      out.push({ name: m[0], from: p, to: end });
      i = Math.max(end, p);
    }
  }
  return out;
}

/** `source` with the literal default of every `sensitive = true` variable replaced by `(sensitive)`. */
export function redactSensitiveDefaults(source: string): string {
  if (!source.includes("sensitive")) return source;
  const spans: [number, number][] = [];
  let i = 0;
  let variable = false;
  while (i < source.length) {
    const c = source[i];
    if (c === "\n") variable = false;
    if (c === '"') { i = skipString(source, i); continue; }
    const k = skipComment(source, i);
    if (k >= 0) { i = k; continue; }
    if (c === "{") {
      const end = skipBraces(source, i);
      if (variable) {
        const attrs = attributes(source, i + 1, end - 1);
        const sensitive = attrs.some((a) => a.name === "sensitive" && source.slice(a.from, a.to) === "true");
        if (sensitive) for (const a of attrs) if (a.name === "default") spans.push([a.from, a.to]);
      }
      variable = false;
      i = end;
      continue;
    }
    WORD.lastIndex = i;
    const m = WORD.exec(source);
    if (m) {
      variable = m[0] === "variable";
      i = WORD.lastIndex;
      continue;
    }
    i++;
  }
  let out = source;
  for (const [a, b] of spans.reverse()) out = out.slice(0, a) + SENSITIVE_PLACEHOLDER + out.slice(b);
  return out;
}

/** chant names the kind `Terraform::Variable`; behold's own pass later writes `block: "variable"`. */
function isVariable(node: unknown, attrs: Record<string, unknown>): boolean {
  return attrs.block === "variable" || (node as { kind?: string }).kind === "Terraform::Variable" || (node as { kind?: string }).kind === "variable";
}

/**
 * Redact every node's `source` attribute, and a sensitive variable's parsed
 * `body.default`, in place. Each file's text is carried
 * by every node of the file, so the answer is memoised per distinct text.
 */
export function redactSensitiveSources(ir: GraphIR): GraphIR {
  const seen = new Map<string, string>();
  for (const node of ir.nodes ?? []) {
    const attrs = (node as { attrs?: Record<string, unknown> }).attrs;
    if (!attrs) continue;
    // The parsed form of the same block: a variable's `body` carries its
    // `default` as a value, whatever shape it has.
    const body = attrs.body as Record<string, unknown> | undefined;
    if (isVariable(node, attrs) && body && typeof body === "object" && body.sensitive === true && "default" in body) body.default = SENSITIVE_PLACEHOLDER;
    const src = attrs.source;
    if (typeof src !== "string") continue;
    let red = seen.get(src);
    if (red === undefined) seen.set(src, (red = redactSensitiveDefaults(src)));
    attrs.source = red;
  }
  return ir;
}
