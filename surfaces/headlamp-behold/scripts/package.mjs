// Packages dist/main.js and package.json as the tarball Headlamp expects
// (a folder named for the plugin holding main.js and package.json), the same
// layout `headlamp-plugin package` writes, but byte for byte reproducible: the
// entries are sorted, their times and owners fixed, and the gzip header
// carries no time. The same commit therefore always gives the same checksum,
// so artifacthub-pkg.yml can name it before the release exists.
//
//   node scripts/package.mjs            write release/<name>-<version>.tar.gz and
//                                       update the checksum in artifacthub-pkg.yml
//   node scripts/package.mjs --check    fail unless a rebuild matches artifacthub-pkg.yml
//
// Run `npm run build` first.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = pkg.name;

function header(path, size) {
  const h = Buffer.alloc(512);
  const put = (s, at, len) => h.write(s, at, len, "ascii");
  put(path, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  put("00000000000\0", 136, 12); // mtime 0
  put("        ", 148, 8); // checksum placeholder: spaces
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  const sum = [...h].reduce((a, b) => a + b, 0);
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

export function tarball() {
  const files = [
    ["main.js", readFileSync(join(root, "dist", "main.js"))],
    ["package.json", readFileSync(join(root, "package.json"))],
  ];
  const parts = [];
  for (const [file, body] of files) {
    parts.push(header(`${name}/${file}`, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  // Stored blocks (level 0) and an "unknown" OS byte (255) in the gzip header:
  // compressed deflate output and the OS byte both differ between a Mac and a
  // Linux runner, so these keep the archive's bytes, and its checksum, the same everywhere.
  const gz = gzipSync(Buffer.concat(parts), { level: 0 });
  gz[9] = 255;
  return gz;
}

const sha = (b) => createHash("sha256").update(b).digest("hex");
const yml = join(root, "artifacthub-pkg.yml");
const wanted = () => /headlamp\/plugin\/archive-checksum:\s*"?(?:sha256:)?([0-9a-f]{64})"?/.exec(readFileSync(yml, "utf8"))?.[1];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tar = tarball();
  const checksum = sha(tar);
  if (process.argv.includes("--check")) {
    if (wanted() !== checksum) {
      console.error(`artifacthub-pkg.yml names ${wanted()}, a rebuild gives ${checksum}. Run node scripts/package.mjs and commit the file.`);
      process.exit(1);
    }
    console.log(`archive-checksum matches: ${checksum}`);
  } else {
    mkdirSync(join(root, "release"), { recursive: true });
    const file = join(root, "release", `${name}-${pkg.version}.tar.gz`);
    writeFileSync(file, tar);
    writeFileSync(`${file}.sha256`, `${checksum}  ${name}-${pkg.version}.tar.gz\n`);
    const text = readFileSync(yml, "utf8").replace(/(headlamp\/plugin\/archive-checksum:\s*)"?[^\n"]*"?/, `$1"${checksum}"`);
    writeFileSync(yml, text);
    console.log(`${file}\nsha256 ${checksum}`);
  }
}
