// A static file server for a folder, on 127.0.0.1, for previewing an export
// (#712: `npm run preview:carve` serves dist-carve on port 4712). GET and
// HEAD only; nothing outside the folder is served.
//
// behold#1164: it serves a Worker bundle as Cloudflare does, so far as a
// check needs. The headers a `_headers` file gives for `/*` go on every
// answer, and `_headers` and the names in `.assetsignore` are not served.
//
//   node scripts/serve-static.mjs <dir> [port]
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const dir = resolve(process.argv[2] || ".");
const port = Number(process.argv[3] || 4712);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".gz": "application/gzip", ".png": "image/png", ".svg": "image/svg+xml" };

/** The `/*` block of a Cloudflare `_headers` file, as header pairs. */
function allPathHeaders(text) {
  const out = {};
  let inAll = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      inAll = line.trim() === "/*";
      continue;
    }
    const i = line.indexOf(":");
    if (inAll && i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}
const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
const extra = allPathHeaders(read("_headers"));
const hidden = new Set(["_headers", ...read(".assetsignore").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)]);

createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = normalize(join(dir, path));
  if ((file !== dir && !file.startsWith(dir + sep)) || hidden.has(file.slice(dir.length + 1).split(sep)[0])) {
    res.writeHead(404).end();
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    const st = statSync(file);
    res.writeHead(200, { ...extra, "content-type": TYPES[extname(file)] || "application/octet-stream", "content-length": st.size, "cache-control": "no-cache" });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { ...extra, "content-type": "text/plain" }).end("not found");
  }
}).listen(port, "127.0.0.1", () => process.stdout.write(`serving ${dir} on http://127.0.0.1:${port}/\n`));
