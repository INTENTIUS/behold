// behold#571: one colour per Terraform root across the kiosk's panes, and the
// hover links between them. Pure logic, plus two small DOM helpers.
//
// A root's colour is its identity, never a state: the state colours (green
// applied, amber waiting or unknown, red failed, blue planned, teal running)
// already mean something, so a root shows its colour only as a small dot by
// its name, never as a text or fill colour. The hues below are none of those,
// and each passes 4.5:1 on its theme's background and panel (checked against
// #1e1e2e, #2e2f40, #11101f and #0f141d for dark; #ffffff and #f6f8fa for
// light).
//
// The colour follows the root's place in the sorted list of declared roots
// (terragucci.components.json), so it is the same on every cycle and on every
// screen showing the same repo.

/** The root hues, by theme: violet, orange, orchid, silver, tan. */
export const ROOT_HUES = {
  dark: ["#b392f0", "#ff9f5a", "#e66ce8", "#e4e4e4", "#c89b6d"],
  light: ["#7c3aed", "#c2410c", "#a21caf", "#334155", "#8b5a2b"],
};

/** The declared roots, sorted and without repeats: the order colours follow. */
export function rootOrder(roots) {
  return [...new Set((roots || []).filter((r) => typeof r === "string" && r))].sort();
}

/** A root's colour, or null for a name that is not a declared root. */
export function rootColour(name, roots, { light = false } = {}) {
  const order = rootOrder(roots);
  const i = order.indexOf(name);
  if (i < 0) return null;
  const hues = light ? ROOT_HUES.light : ROOT_HUES.dark;
  return hues[i % hues.length];
}

// A token holding any of these is an address, a path, a hash or a key=value:
// a root name inside it is not a mention of the root.
const NOT_PROSE = /:\/\/|\/|=|^[0-9a-f]{7,}$|^jcs\d|sha\d+:/i;
const WORD = /[\w-]/;

/**
 * Split a line into runs of plain text and whole-word root names, for the
 * kiosk to put a dot by each name. A name counts only as a word of its own:
 * not inside a URL, a path, a hash or an address such as
 * `terraform_data.app_x` or `app:9080`, and not as part of a longer word
 * (`apply-wave-2`, `appliance`). "network's" and "(app)" count.
 * Returns `[{ text }, { text, root }, …]`; joined, the texts are the line.
 */
export function rootSegments(text, roots) {
  const s = typeof text === "string" ? text : "";
  const names = rootOrder(roots).sort((a, b) => b.length - a.length);
  if (!s || !names.length) return s ? [{ text: s }] : [];
  const out = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ text: plain });
    plain = "";
  };
  // Whitespace runs and tokens, in order.
  for (const part of s.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part) || NOT_PROSE.test(part)) {
      plain += part;
      continue;
    }
    let i = 0;
    while (i < part.length) {
      const name = names.find((n) => part.startsWith(n, i) && wholeWord(part, i, n.length));
      if (!name) {
        plain += part[i];
        i += 1;
        continue;
      }
      flush();
      out.push({ text: name, root: name });
      i += name.length;
    }
  }
  flush();
  return out;
}

function wholeWord(token, at, len) {
  const before = at > 0 ? token[at - 1] : "";
  const after = token[at + len] || "";
  const rest = token.slice(at + len + 1);
  if (before && (WORD.test(before) || before === "." || before === ":" || before === "@" || before === "#")) return false;
  if (!after) return true;
  if (WORD.test(after)) return false;
  // `terraform_data.app.x`, `app:9080`: an address or a host, not the root.
  if ((after === "." || after === ":") && rest && /[\w"[]/.test(rest[0])) return false;
  return true;
}

/** The wave a pipeline job applies: from the declared jobs, else from its name (`apply-wave-2`). */
export function waveOfJob(job, waves = []) {
  const w = (waves || []).find((x) => x.job === job);
  if (w) return w.wave;
  const m = /^apply-wave-(\d+)$/.exec(job || "");
  return m ? Number(m[1]) : null;
}

/** The roots a wave applies, from the declared jobs. */
export function rootsOfWave(wave, waves = []) {
  const w = (waves || []).find((x) => x.wave === wave);
  return w ? [...w.roots] : [];
}

/**
 * What a hover lights across the panes. A root lights its own mentions and
 * box or card, and the job row and box of the wave that applies it; a wave
 * (a job row, a wave box) lights its own row and box, and the roots it
 * applies. Null lights nothing.
 */
export function hoverLinks(hover, waves = []) {
  const out = { roots: [], waves: [] };
  if (!hover) return out;
  if (typeof hover.root === "string" && hover.root) {
    out.roots.push(hover.root);
    for (const w of waves || []) if (w.roots.includes(hover.root) && !out.waves.includes(w.wave)) out.waves.push(w.wave);
  } else if (typeof hover.wave === "number") {
    out.waves.push(hover.wave);
    for (const r of rootsOfWave(hover.wave, waves)) if (!out.roots.includes(r)) out.roots.push(r);
  }
  return out;
}

/** The `behold:hover` message both sides send: a root, a wave, or null for neither. */
export function hoverMessage(hover) {
  return { type: "behold:hover", root: hover && typeof hover.root === "string" ? hover.root : null, wave: hover && typeof hover.wave === "number" ? hover.wave : null };
}

/** A `behold:hover` message reduced to a hover, or undefined when it is not one. */
export function hoverFromMessage(data) {
  if (!data || typeof data !== "object" || data.type !== "behold:hover") return undefined;
  if (typeof data.root === "string" && data.root) return { root: data.root };
  if (typeof data.wave === "number" && Number.isInteger(data.wave)) return { wave: data.wave };
  return null;
}

/** Whether a background colour (`#rrggbb`) is light. */
export function isLightBg(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 > 0.5;
}

/** A dot in a root's colour, for beside its name. */
export function rootDot(doc, name, colour) {
  const dot = doc.createElement("span");
  dot.className = "k-root-dot";
  dot.setAttribute("aria-hidden", "true");
  dot.style.setProperty("--k-root", colour);
  dot.dataset.kRoot = name;
  return dot;
}

/** A line as nodes: plain text, and each root name in a span with its dot. */
export function rootText(doc, text, roots, { light = false } = {}) {
  const frag = doc.createDocumentFragment();
  for (const seg of rootSegments(text, roots)) {
    if (!seg.root) {
      frag.appendChild(doc.createTextNode(seg.text));
      continue;
    }
    const span = doc.createElement("span");
    span.className = "k-root";
    span.dataset.kRoot = seg.root;
    span.style.setProperty("--k-root", rootColour(seg.root, roots, { light }));
    span.textContent = seg.text;
    frag.appendChild(span);
  }
  return frag;
}

/**
 * The CSS that lights what a hover links, as one rule set: a style element
 * holding it survives the panes' redraws, which replace their nodes every
 * second. `sel` builds the selectors for a root name and for a wave
 * number; quote a name with cssString.
 */
export function hoverCss(links, sel, rule) {
  const parts = [...links.roots.map((r) => sel.root(r)), ...links.waves.map((w) => sel.wave(w))].filter(Boolean);
  return parts.length ? `${parts.join(",\n")} { ${rule} }` : "";
}

/** A value quoted for an attribute selector. */
export function cssString(s) {
  return `"${String(s).replace(/["\\]/g, "\\$&").replace(/\n/g, "\\a ")}"`;
}
