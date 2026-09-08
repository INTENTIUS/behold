/**
 * Version floors. Pure, and imported by modules that must not import
 * src/chant.ts at runtime (src/chant.ts imports src/project.ts, which imports
 * the member-kind registry — see src/member-kind.ts's header for the cycle
 * this avoids). src/chant.ts re-exports it, so its callers are unchanged.
 */

/** Does `version` meet `floor`? Numeric dotted compare, prerelease suffix
 * dropped (`0.44.3-rc.1` compares as `0.44.3` — an rc of the floor is close
 * enough to not warn about; a git-describe build `v0.15.0-30-g9c7d…` compares
 * as `0.15.0`). A leading `v` is ignored. Unparseable input answers `true`: an
 * unknown version is not evidence of an old one. */
export function meetsFloor(version: string | undefined, floor: string | undefined): boolean {
  if (!version || !floor) return true;
  const parts = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10));
  const a = parts(version);
  const b = parts(floor);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return true;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}
