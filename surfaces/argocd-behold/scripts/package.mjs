// Packages the build as the tarball argocd-extension-installer takes: a gzip
// tar with a top-level resources/ directory holding the extension, and a
// checksums.txt in the "<sha256>  <file>" form its EXTENSION_CHECKSUM_URL reads.
// The bytes are reproducible: sorted entries, fixed times and owners, no time
// in the gzip header. Run `npm run build` first.
//
//   node scripts/package.mjs     write release/argocd-behold-<version>.tar.gz and checksums.txt
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function header(path, size, type = "0") {
  const h = Buffer.alloc(512);
  const put = (s, at, len) => h.write(s, at, len, "ascii");
  put(path, 0, 100);
  put(type === "5" ? "0000755\0" : "0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  put("00000000000\0", 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  const sum = [...h].reduce((a, b) => a + b, 0);
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

export function tarball() {
  const body = readFileSync(join(root, "dist", "resources", "extension-behold.js", "extension-behold.js"));
  const parts = [
    header("resources/", 0, "5"),
    header("resources/extension-behold.js/", 0, "5"),
    header("resources/extension-behold.js/extension-behold.js", body.length),
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
    Buffer.alloc(1024),
  ];
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tar = tarball();
  const name = `${pkg.name}-${pkg.version}.tar.gz`;
  mkdirSync(join(root, "release"), { recursive: true });
  writeFileSync(join(root, "release", name), tar);
  const sha = createHash("sha256").update(tar).digest("hex");
  writeFileSync(join(root, "release", "checksums.txt"), `${sha}  ${name}\n`);
  console.log(`${join(root, "release", name)}\nsha256 ${sha}`);
}
