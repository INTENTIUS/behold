/**
 * behold#1005: the chant release behold's newest reads need, set in one place.
 *
 * chant 0.124.54 is on npm (0.124.53 was cut and never published). It is the
 * first release with the drift record and its stream, the adoption report,
 * `member-outputs` and the pulumi lexicon, and behold depends on it.
 *
 * Everything that names that release reads this constant:
 *
 *  - the floors in src/chant-floors.ts (`ADOPTION_REPORT_CHANT_FLOOR`,
 *    `DRIFT_RECORD_CHANT_FLOOR`, `DRIFT_STREAM_CHANT_FLOOR`,
 *    `LEDGER_ROOT_MEMBER_CHANT_FLOOR`), which are `version`;
 *  - the pins and dependencies scripts/chant-release.ts writes: the
 *    three-cloud workspace's lexicon pins and package.json, the exact
 *    terraform lexicon pins of example-terraform-estate and
 *    example-choudoufu-estate, the pulumi-workspace fixture's pulumi lexicon
 *    pin, and behold's own chant dependencies (src/chant-release-sync.ts).
 *
 * While `released` is false, the ranges and the exact lexicon pins name the
 * newest published chant ({@link PUBLISHED_CHANT}), so a plain `npm ci`
 * resolves and meets the pins (behold#1015), and the three-cloud workspace
 * pins its lexicons by path. Once it is true, every range and exact pin
 * names `version`, and the three-cloud workspace pins both lexicons by
 * package and version and depends on them.
 *
 * `npx tsx scripts/chant-release.ts --check` fails when a written file
 * disagrees with this line (src/chant-release.test.ts runs it).
 */
export const CHANT_RELEASE = { version: "0.124.54", released: true } as const;

/** The newest chant on npm, the range a dependency keeps while {@link CHANT_RELEASE} is unreleased. */
export const PUBLISHED_CHANT = "0.124.54";
