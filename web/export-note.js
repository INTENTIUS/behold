// #824: the line an export shows at its foot, from `behold export --note`.
// The manifest carries it as `note`; a static page draws it under the graph,
// where the three-cloud demo's page says how to run the estate yourself.
// Plain text, with a span in backticks drawn as code. Nothing else is markup:
// the text is set as text, never as HTML.

/** The note split into runs of plain text and code, in order. An unclosed
 * backtick is kept as text. */
export function noteSegments(text) {
  const out = [];
  const re = /`([^`]+)`/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ code: false, text: text.slice(at, m.index) });
    out.push({ code: true, text: m[1] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ code: false, text: text.slice(at) });
  return out;
}

/** The note a manifest carries, or null when it carries none. */
export function manifestNote(manifest) {
  const note = manifest && typeof manifest.note === "string" ? manifest.note.trim() : "";
  return note || null;
}

/** Fill `el` with the note and show it; hide it when there is no note. */
export function renderExportNote(el, doc, manifest) {
  const note = manifestNote(manifest);
  el.textContent = "";
  el.hidden = !note;
  if (!note) return;
  for (const seg of noteSegments(note)) el.appendChild(seg.code ? Object.assign(doc.createElement("code"), { textContent: seg.text }) : doc.createTextNode(seg.text));
}
