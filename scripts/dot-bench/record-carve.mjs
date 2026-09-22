#!/usr/bin/env node
// Record a carve of a live choudoufu estate as one JSON Lines file (#457).
//
//   node scripts/dot-bench/record-carve.mjs --estate-dir <dir> --out carve.jsonl [--plan domains] [--workers 4]
//
// <dir> is a live estate choudoufu has applied: its *.tf, its
// `estate.chdf.hcl` sidecar and its `.terraform/` from `choudoufu init`. The
// workbench's `terralith-14` entry leaves exactly that in its target. AWS_*
// (the emulator endpoint and dummy credentials) come from the environment,
// as they do for every choudoufu call; this script never names an account.
//
// What it does, and all it does:
//
//   1. For each destination estate the plan names, make a sibling directory
//      holding a copy of the source configuration under that estate's name
//      (a new sidecar, the same *.tf, `.terraform/` linked). Copying the
//      whole configuration means every address is declared at every
//      destination, so any planned move is legal; a real carve would move
//      only each estate's share of the blocks, which changes nothing that is
//      recorded here.
//   2. Roster: `live-check -json` in the source, once. It is the only read that
//      names every instance: live-ls lists what carries a marker tag (the
//      `tag-governable` rung) and nothing else, so the untaggable children
//      (`declaration-carried`: inline policies, attachments, records) exist
//      in a recording only because the roster line names them.
//      Keyframe: `live-ls -estate=<e> -json -consistent` for the source and
//      every destination, whole, as one line.
//   3. For each planned address, `live-mv -from-estate=<src> -json <a> <a>`
//      run in the destination's directory, its document appended as one
//      `move` line with a timestamp (live-mv's own document has none).
//   4. A keyframe after every `--keyframe-every` moves and at the end.
//
// The format, one JSON object per line, each with `kind` and `t` (ISO 8601):
//
//   {kind:"header",  version:1, source, destinations, plan, choudoufu, endpoint}
//   {kind:"roster",  instances: [{address, type, rung}]}   (live-check -json)
//   {kind:"keyframe", seq, estates: {<estate>: <live-ls -json document>}}
//   {kind:"move",    seq, estate, address, doc: <live-mv -json document> | null,
//                    exit, stderr?, seconds}
//   {kind:"end",     moves, refused, seconds}
//
// The write is live-mv's, on an emulator, and only ever run by hand: behold
// has no route that runs live-mv and this script is not one.

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const estateDir = resolve(arg("estate-dir", ""));
const out = resolve(arg("out", "carve.jsonl"));
const planName = arg("plan", "domains");
const workers = Number(arg("workers", 4));
const keyframeEvery = Number(arg("keyframe-every", 100));
const limit = Number(arg("limit", Infinity));
const bin = process.env.CHOUDOUFU_BIN || "choudoufu";

const now = () => new Date().toISOString();
const line = (obj) => appendFileSync(out, JSON.stringify({ t: now(), ...obj }) + "\n");

function sourceEstate() {
  const sidecar = readFileSync(join(estateDir, "estate.chdf.hcl"), "utf8");
  const m = /estate\s*=\s*"([^"]+)"/.exec(sidecar);
  if (!m) throw new Error(`no estate = "..." in ${estateDir}/estate.chdf.hcl`);
  return m[1];
}

/**
 * The carve plans. A plan maps a live-ls item (address, type) to the estate it
 * should end up in, or undefined to leave it in the source.
 *
 * `domains` is the split a terralith's owners would plausibly make: every
 * team's identity resources go to one of six business domains by team number,
 * the services and their execution roles to `platform`, the DNS zone and
 * records to `edge`, and the shared VPC, subnet, security group and ECS
 * cluster stay in the monolith. Untaggable children are never planned: they
 * follow their parent, which is what live-mv's `followers` records.
 */
const DOMAINS = ["identity", "billing", "search", "growth", "data", "support"];
const PLANS = {
  domains(item, source) {
    const a = item.address;
    if (/aws_route53_/.test(item.type)) return `${source}-edge`;
    if (/(^|\.)aws_(ecs_service|ecs_task_definition)\b/.test(a) || /svc/.test(a)) return `${source}-platform`;
    if (/aws_(vpc|subnet|security_group|ecs_cluster)\b/.test(item.type)) return undefined;
    const n = /(\d+)/.exec(a.replace(/^.*?\./, ""));
    const k = /\["([a-z]+)"\]/.exec(a);
    const idx = (n ? Number(n[1]) : 0) + (k ? k[1].charCodeAt(0) : 0);
    return `${source}-${DOMAINS[idx % DOMAINS.length]}`;
  },
};

function prepareDestination(source, estate) {
  const dir = join(dirname(estateDir), `${basename(estateDir)}--${estate}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(estateDir)) {
      if (name.endsWith(".tf") || name === ".terraform.lock.hcl") cpSync(join(estateDir, name), join(dir, name));
      if (name === "modules") cpSync(join(estateDir, name), join(dir, name), { recursive: true });
    }
    symlinkSync(join(estateDir, ".terraform"), join(dir, ".terraform"));
    writeFileSync(join(dir, "estate.chdf.hcl"), `estate = "${estate}"\n\nrecord_store "local" {\n  path = ".tofu-records"\n}\n`);
  }
  return dir;
}

async function liveLs(dir, estate) {
  const { stdout } = await run(bin, ["live-ls", `-estate=${estate}`, "-json", "-consistent"], { cwd: dir, maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function keyframe(seq, dirs) {
  const estates = {};
  for (const [estate, dir] of Object.entries(dirs)) estates[estate] = await liveLs(dir, estate);
  line({ kind: "keyframe", seq, estates });
  return estates;
}

async function move(source, dest, dir, address) {
  const started = Date.now();
  try {
    const { stdout } = await run(bin, ["live-mv", `-from-estate=${source}`, "-json", "-no-color", address, address], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    return { doc: JSON.parse(stdout), exit: 0, seconds: (Date.now() - started) / 1000 };
  } catch (err) {
    let doc = null;
    try { doc = JSON.parse(err.stdout); } catch { /* not a document */ }
    return { doc, exit: typeof err.code === "number" ? err.code : 1, stderr: String(err.stderr || err.message).slice(0, 2000), seconds: (Date.now() - started) / 1000 };
  }
}

async function main() {
  if (!existsSync(join(estateDir, "estate.chdf.hcl"))) throw new Error("--estate-dir must be an applied choudoufu estate (no estate.chdf.hcl there)");
  const plan = PLANS[planName];
  if (!plan) throw new Error(`unknown --plan ${planName}; known: ${Object.keys(PLANS).join(", ")}`);
  const source = sourceEstate();
  rmSync(out, { force: true });
  const started = Date.now();

  const first = await liveLs(estateDir, source);
  const moves = [];
  for (const item of first.items ?? []) {
    if (!item.address) continue;
    const dest = plan(item, source);
    if (dest) moves.push({ address: item.address, dest });
  }
  moves.sort((a, b) => (a.address < b.address ? -1 : 1));
  const planned = moves.slice(0, limit);
  const destinations = [...new Set(planned.map((m) => m.dest))].sort();
  const dirs = { [source]: estateDir };
  for (const d of destinations) dirs[d] = prepareDestination(source, d);

  const { stdout: version } = await run(bin, ["version"]).catch(() => ({ stdout: "unknown" }));
  line({ kind: "header", version: 1, source, destinations, plan: planName, planned: planned.length,
    choudoufu: version.split("\n")[0], endpoint: process.env.AWS_ENDPOINT_URL ?? null });
  const { stdout: check } = await run(bin, ["live-check", "-json"], { cwd: estateDir, maxBuffer: 256 * 1024 * 1024 });
  line({ kind: "roster", instances: JSON.parse(check).instances ?? [] });
  await keyframe(0, dirs);

  let seq = 0;
  let refused = 0;
  let next = 0;
  // Moves run in parallel batches; a keyframe is taken between batches, never
  // while a move is in flight, so every keyframe is a consistent cut.
  while (next < planned.length) {
    const batchEnd = Math.min(planned.length, next + keyframeEvery);
    const stop = next;
    const saved = planned.length;
    await Promise.all(Array.from({ length: Math.min(workers, batchEnd - stop) }, async () => {
      for (;;) {
        if (next >= batchEnd) return;
        const i = next++;
        const m = planned[i];
        const r = await move(source, m.dest, dirs[m.dest], m.address);
        seq++;
        if (r.exit !== 0) refused++;
        line({ kind: "move", seq, estate: m.dest, address: m.address, ...r });
        process.stderr.write(`\r  ${seq}/${saved} moved, ${refused} refused`);
      }
    }));
    await keyframe(seq, dirs);
  }
  process.stderr.write("\n");
  line({ kind: "end", moves: seq, refused, seconds: (Date.now() - started) / 1000 });
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
