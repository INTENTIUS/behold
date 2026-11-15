#!/usr/bin/env node
// Writes the inputs for the GitHub forge-limits check (behold#1065).
// usage: node gen.mjs <outdir>
// outdir/mermaid/<name>.mmd   bare diagram source
// outdir/comments/<name>.md   the same diagram in a ```mermaid fence
// outdir/bodies/<name>.txt    plain comment bodies for the size limit probe
// outdir/attach/probe.{svg,png}
// outdir/manifest.json        name, kind, characters, edges of every file
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
if (!out) { console.error("usage: node gen.mjs <outdir>"); process.exit(2); }
for (const d of ["mermaid", "comments", "bodies", "attach"]) mkdirSync(join(out, d), { recursive: true });

const manifest = [];

// A flowchart with exactly `edges` edges over short ids (a chain plus skip links).
function byEdges(edges) {
  const nodes = Math.ceil(edges / 2) + 2;
  const lines = ["flowchart TD"];
  for (let i = 0; i < nodes; i++) lines.push(`  n${i}["res ${i}"]`);
  let e = 0;
  for (let i = 0; i + 1 < nodes && e < edges; i++) { lines.push(`  n${i} --> n${i + 1}`); e++; }
  for (let i = 0; i + 2 < nodes && e < edges; i++) { lines.push(`  n${i} -.-> n${i + 2}`); e++; }
  if (e !== edges) throw new Error(`could not build ${edges} edges`);
  return { text: lines.join("\n") + "\n", edges };
}

// A small flowchart padded with %% comment lines to exactly `chars` characters.
function byChars(chars) {
  const base = ["flowchart TD", '  a["changed"] --> b["neighbour"]'].join("\n") + "\n";
  let text = base;
  const pad = chars - text.length;
  if (pad < 0) throw new Error(`${chars} is smaller than the base diagram`);
  if (pad > 0) {
    const lines = [];
    let left = pad;
    while (left > 0) {
      const n = Math.min(left, 80);
      // a line is "%%" + filler + "\n"; the shortest is 3 characters
      const len = left - n > 0 && left - n < 3 ? n - 3 : n;
      lines.push("%%" + "x".repeat(Math.max(len - 3, 0)) + "\n");
      left -= Math.max(len - 3, 0) + 3;
    }
    text += lines.join("");
  }
  if (text.length !== chars) throw new Error(`built ${text.length}, wanted ${chars}`);
  return { text, edges: 1 };
}

function mermaid(name, { text, edges }) {
  writeFileSync(join(out, "mermaid", `${name}.mmd`), text);
  const md = "```mermaid\n" + text + "```\n";
  writeFileSync(join(out, "comments", `${name}.md`), md);
  manifest.push({ name, kind: "mermaid", diagramChars: text.length, commentChars: md.length, edges });
}

// The renderer's own version, printed by GitHub's `info` diagram.
mermaid("info", { text: "info\n", edges: 0 });

for (const e of [50, 200, 499, 500, 501, 1000]) mermaid(`edges-${e}`, byEdges(e));
for (const c of [1000, 2000, 2001, 10000, 20000, 49000, 50000, 50001, 60000]) mermaid(`chars-${c}`, byChars(c));

// Comment bodies around 65,536, in ASCII and in two-byte characters.
const body = (n, ch) => ch.repeat(n);
for (const n of [65535, 65536, 65537]) {
  writeFileSync(join(out, "bodies", `ascii-${n}.txt`), body(n, "a"));
  manifest.push({ name: `ascii-${n}`, kind: "body", commentChars: n, bytes: n });
}
writeFileSync(join(out, "bodies", "twobyte-65536.txt"), body(65536, "é"));
manifest.push({ name: "twobyte-65536", kind: "body", commentChars: 65536, bytes: 131072 });

// Attach probes: a minimal SVG and a 1x1 PNG.
writeFileSync(join(out, "attach", "probe.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#2b6cb0"/><text x="8" y="26" fill="#fff" font-size="14">behold 1065</text></svg>\n');
writeFileSync(join(out, "attach", "probe.png"), Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/h0u4ZgAAAABJRU5ErkJggg==", "base64"));

writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${manifest.length} fixtures to ${out}`);
