// A static file server for a folder, on 127.0.0.1, for previewing an export
// (#712: `npm run preview:carve` serves dist-carve on port 4712). GET and
// HEAD only; nothing outside the folder is served.
//
//   node scripts/serve-static.mjs <dir> [port]
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const dir = resolve(process.argv[2] || ".");
const port = Number(process.argv[3] || 4712);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".gz": "application/gzip", ".png": "image/png", ".svg": "image/svg+xml" };

createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = normalize(join(dir, path));
  if (file !== dir && !file.startsWith(dir + sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    const st = statSync(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "content-length": st.size, "cache-control": "no-cache" });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}).listen(port, "127.0.0.1", () => process.stdout.write(`serving ${dir} on http://127.0.0.1:${port}/\n`));
