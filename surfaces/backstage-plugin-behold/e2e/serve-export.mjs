// A static server for a `behold export` directory with CORS, standing in for
// the published site (GitHub Pages sends access-control-allow-origin: *).
//   node e2e/serve-export.mjs <export-dir> [port] [--private <token>]
// With --private, a request needs `authorization: Bearer <token>`, which is
// how the proxy test shows a private bucket read through proxy.endpoints.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const args = process.argv.slice(2);
const pi = args.indexOf("--private");
const token = pi >= 0 ? args[pi + 1] : undefined;
const rest = args.filter((_, i) => pi < 0 || (i !== pi && i !== pi + 1));
const dir = rest[0];
const port = Number(rest[1] ?? 4801);
if (!dir) {
  console.error("usage: serve-export.mjs <export-dir> [port] [--private <token>]");
  process.exit(2);
}
const types = { ".json": "application/json", ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (token && req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end("unauthorized");
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = await readFile(join(dir, path.endsWith("/") ? `${path}index.html` : path));
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => console.log(`serving ${dir} on http://localhost:${port}${token ? " (bearer required)" : ""}`));
