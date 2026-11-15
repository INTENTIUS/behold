// Serves release/ (the extension tarball and checksums.txt) with CORS on the port given, so the installer init
// container in the cluster can download the extension from the host as host.k3d.internal.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "release");
const port = Number(process.argv[2] || 8099);
createServer((req, res) => {
  const name = (req.url || "/").split("?")[0].slice(1);
  res.setHeader("access-control-allow-origin", "*");
  console.log(req.method, req.url);
  const file = join(root, name.replace(/[^A-Za-z0-9._-]/g, ""));
  if (!name || !existsSync(file)) return void res.writeHead(404).end();
  res.end(readFileSync(file));
}).listen(port, "0.0.0.0", () => console.log(`serving ${root} on ${port}`));
