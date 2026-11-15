// Builds the release archive krew installs from, byte for byte reproducible:
// kubectl-behold (mode 0755) and the repository LICENSE, entries sorted,
// times and owners fixed, no time and no OS in the gzip header, and the gzip written
// with stored blocks only (level 0). Compressed deflate output depends on the
// zlib build, so a Mac and a Linux runner gave different bytes; stored blocks
// are fixed by the format. The same commit always gives the same checksum on
// any machine, so krew/behold.yaml can name it before the release exists.
//
//   node scripts/package.mjs            write release/kubectl-behold-v<ver>.tar.gz
//                                       and put its checksum in krew/behold.yaml
//   node scripts/package.mjs --check    fail unless a rebuild matches krew/behold.yaml
//
// The version is spec.version in krew/behold.yaml. The release tag is
// kubectl-behold-v<ver>, and the manifest's uri must name it.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "krew", "behold.yaml");

function header(path, size, mode) {
  const h = Buffer.alloc(512);
  const put = (s, at, len) => h.write(s, at, len, "ascii");
  put(path, 0, 100);
  put(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  put("00000000000\0", 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  const sum = [...h].reduce((a, b) => a + b, 0);
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

export function archive() {
  const files = [
    ["LICENSE", readFileSync(join(root, "..", "..", "LICENSE")), 0o644],
    ["kubectl-behold", readFileSync(join(root, "kubectl-behold")), 0o755],
  ];
  const parts = [];
  for (const [file, body, mode] of files) parts.push(header(file, body.length, mode), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  parts.push(Buffer.alloc(1024));
  const gz = gzipSync(Buffer.concat(parts), { level: 0 });
  // Byte 9 of the gzip header names the OS that wrote it (19 on macOS, 3 on
  // Linux); 255 is "unknown", the same on every machine.
  gz[9] = 255;
  return gz;
}

const sha = (b) => createHash("sha256").update(b).digest("hex");
const manifest = readFileSync(manifestPath, "utf8");
const version = /^\s*version:\s*"(v\d+\.\d+\.\d+)"/m.exec(manifest)?.[1];
if (!version) throw new Error("krew/behold.yaml has no spec.version like \"v0.1.0\"");
const name = `kubectl-behold-${version}.tar.gz`;
const uri = `https://github.com/INTENTIUS/behold/releases/download/kubectl-behold-${version}/${name}`;
const wanted = /sha256:\s*"?([0-9a-f]{64})"?/.exec(manifest)?.[1];
const named = /uri:\s*(\S+)/.exec(manifest)?.[1];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tar = archive();
  const checksum = sha(tar);
  if (process.argv.includes("--check")) {
    if (named !== uri) {
      console.error(`krew/behold.yaml uri is ${named}, the release for ${version} is ${uri}`);
      process.exit(1);
    }
    if (wanted !== checksum) {
      console.error(`krew/behold.yaml names ${wanted}, a rebuild gives ${checksum}. Run node scripts/package.mjs and commit the file.`);
      process.exit(1);
    }
    console.log(`krew checksum matches: ${checksum}`);
  } else {
    mkdirSync(join(root, "release"), { recursive: true });
    const file = join(root, "release", name);
    writeFileSync(file, tar);
    writeFileSync(`${file}.sha256`, `${checksum}  ${name}\n`);
    writeFileSync(manifestPath, manifest.replace(/(sha256:\s*)"?[0-9a-f]{64}"?/, `$1"${checksum}"`).replace(/(uri:\s*)\S+/, `$1${uri}`));
    console.log(`${file}\nsha256 ${checksum}`);
  }
}
