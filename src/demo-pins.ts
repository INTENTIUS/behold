/**
 * A demo copy reads its pinned kinds from the packages behold resolved (#484).
 *
 * Since #464 a bundled estate demo is a declared workspace, and its member
 * kinds come from `chant workspace ls` run in the copy. chant reads a pinned
 * package from the workspace root's own node_modules, at exactly the pinned
 * version (chant src/workspace/kinds.ts `pinnedPackageDir`). A demo copy has
 * no node_modules, so a lexicon installed beside behold, where the README and
 * the refusal say to put it, was never seen, and every member drew as
 * `unknown-kind`. The preflight looked beside behold; chant looked beside the
 * workspace.
 *
 * So a copy gets, for each package pin, a node_modules link to the package
 * behold resolves, and the pin is set to that package's version. A pin behold
 * cannot resolve refuses the demo before anything is served, with the same
 * words the reader's own refusal uses. This only ever touches a copy behold
 * made: an in-place entry is somebody's checkout and is served as it sits.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolvedPackage, terraformReaderState, TERRAFORM_LEXICON_PKG, type TerraformReaderState } from "./terraform-member.ts";

export interface LinkedPin {
  pkg: string;
  version: string;
  /** The version the copy's declaration pinned before, when it differed. */
  was?: string;
}

export type DemoPinsResult = { ok: true; linked: LinkedPin[] } | { ok: false; error: string; remedy: string };

export interface DemoPinsProbes {
  resolve?: (pkg: string) => { dir: string; version: string } | undefined;
  reader?: () => TerraformReaderState;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Point a demo copy's package pins at the packages behold resolves. Idempotent: a reused copy is checked again, and an existing link is left as it is. */
export function linkDemoPins(work: string, probes: DemoPinsProbes = {}): DemoPinsResult {
  const file = join(work, "chant.workspace.json");
  if (!existsSync(file)) return { ok: true, linked: [] };
  let decl: unknown;
  try {
    decl = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // chant reports an unreadable declaration in its own words when it is served.
    return { ok: true, linked: [] };
  }
  if (!isRecord(decl) || !Array.isArray(decl.pins)) return { ok: true, linked: [] };
  const find = probes.resolve ?? ((pkg: string) => resolvedPackage(pkg));
  const linked: LinkedPin[] = [];
  let rewrite = false;
  for (const pin of decl.pins) {
    if (!isRecord(pin) || typeof pin.package !== "string") continue;
    const pkg = pin.package;
    // The terraform lexicon reads HCL through a second optional peer, and the
    // reader's own refusal names both: the same line the README promises.
    if (pkg === TERRAFORM_LEXICON_PKG) {
      const refusal = (probes.reader ?? terraformReaderState)().refusal;
      if (refusal) return { ok: false, error: refusal.error, remedy: refusal.remedy };
    }
    const found = find(pkg);
    if (!found) {
      return {
        ok: false,
        error: `This demo's chant.workspace.json pins ${pkg}, which behold does not install, and it is not resolvable beside behold.`,
        remedy: `Install ${pkg} beside behold, then load the demo again.`,
      };
    }
    const link = join(work, "node_modules", ...pkg.split("/"));
    if (!present(link)) {
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(found.dir, link, "junction");
    } else if (!linksTo(link, found.dir)) {
      // A real install in the copy (somebody ran npm install there) is theirs:
      // chant reads it, and the pin has to name what it holds, not behold's.
      continue;
    }
    const entry: LinkedPin = { pkg, version: found.version };
    if (pin.version !== found.version) {
      if (typeof pin.version === "string") entry.was = pin.version;
      pin.version = found.version;
      rewrite = true;
    }
    linked.push(entry);
  }
  if (rewrite) writeFileSync(file, JSON.stringify(decl, null, 2) + "\n");
  return { ok: true, linked };
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function linksTo(link: string, target: string): boolean {
  try {
    return lstatSync(link).isSymbolicLink() && resolve(dirname(link), readlinkSync(link)) === resolve(target);
  } catch {
    return false;
  }
}
