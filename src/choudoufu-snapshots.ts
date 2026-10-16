/**
 * A choudoufu reader over snapshot files instead of a binary.
 *
 * Where behold has no choudoufu to run (a container with no binary, a host
 * whose role reads only a reports prefix), whoever ran the tool can write its
 * documents as files, and behold reads those. The layout is the one
 * `behold demo terralith`'s scripts write (src/terralith-demo.ts): one
 * directory per root, named after the root, holding `live-check.json`,
 * `live-ls.json` and `live-plan.json`, and `live-mv/<root>--<address>.dry-run.json`
 * beside the roots.
 *
 * `snapshotRunner` answers the reads behold spawns (the `Runner` seam in
 * src/choudoufu-live.ts) with those files, so every choudoufu view behold
 * already draws works from a snapshot unchanged. It answers reads only: a
 * `live-mv` without `-dry-run`, or any other verb, gets exit 2 and says the
 * snapshot holds no answer, exactly as a missing file does.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Captured } from "./choudoufu-member.ts";
import type { Runner } from "./choudoufu-live.ts";

const missing = (what: string): Captured => ({ code: 2, stdout: "", stderr: `behold: the snapshot holds no ${what}\n` });

/** Which snapshot file answers this argv, run in a root named `root`; undefined when none does. */
export function snapshotFileFor(args: readonly string[], root: string): string | undefined {
  const verb = args[0];
  if (verb === "live-check" && args.includes("-json")) return join(root, "live-check.json");
  if (verb === "live-ls" && args.includes("-json")) return join(root, "live-ls.json");
  if (verb === "live-plan" && args.includes("-json")) return join(root, "live-plan.json");
  if (verb === "live-mv" && args.includes("-dry-run")) {
    const operands = args.filter((a) => !a.startsWith("-"));
    const address = operands[1];
    return address ? join("live-mv", `${root}--${address}.dry-run.json`) : undefined;
  }
  return undefined;
}

/** A Runner over one phase directory of snapshots. `cwd`'s last segment names the root. */
export function snapshotRunner(phaseDir: string): Runner {
  return async (args, cwd) => {
    const rel = snapshotFileFor(args, basename(cwd));
    if (!rel) return missing(`answer to \`choudoufu ${args.join(" ")}\``);
    const path = join(phaseDir, rel);
    if (!existsSync(path)) return missing(rel);
    return { code: 0, stdout: readFileSync(path, "utf8"), stderr: "" };
  };
}
