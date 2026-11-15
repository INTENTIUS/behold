/**
 * behold#1057: read a directory into behold's graph with no server started,
 * and print how many nodes it has. The check that `readGraph`
 * (src/read-graph.ts) needs nothing the server sets up.
 *
 *   npx tsx scripts/read-graph.ts <dir> [--detail <0..3>]
 *
 * `<dir>` is a folder of `.tf` files, a chant workspace root, a choudoufu
 * estate or a chant project. Prints the node count (`37 nodes`) and, on stderr, the member
 * kinds' note when there is one.
 */
import { resolve } from "node:path";
import { readGraph, ReadGraphError } from "../src/read-graph.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--detail");
const detail = at >= 0 ? Number(args.splice(at, 2)[1]) : undefined;
const dir = args[0];
if (!dir || (detail !== undefined && !(detail >= 0 && detail <= 3))) {
  process.stderr.write("usage: npx tsx scripts/read-graph.ts <dir> [--detail <0..3>]\n");
  process.exit(2);
}
try {
  const { ir, meta } = await readGraph(resolve(dir), detail !== undefined ? { detail } : {});
  process.stdout.write(`${ir.nodes.length} ${ir.nodes.length === 1 ? "node" : "nodes"}\n`);
  if (meta.note) process.stderr.write(`${meta.note}\n`);
} catch (err) {
  if (err instanceof ReadGraphError) {
    process.stderr.write(`${err.refusal.error}\n${err.refusal.remedy}\n`);
    process.exit(1);
  }
  throw err;
}
