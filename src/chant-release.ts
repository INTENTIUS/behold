/**
 * behold#1005: the chant release behold's unreleased-chant work waits on, set
 * in one place.
 *
 * behold reads chant features no published chant has yet (the drift record
 * and its stream, the adoption report, `member-outputs`, the pulumi lexicon).
 * Until the maintainer cuts the chant release that carries them, behold runs
 * against a local build of chant's integration branch: `npm pack` tarballs
 * with every package's version stamped at {@link CHANT_RELEASE}'s `version`,
 * installed with `npm install --no-save`. `version` is chant's own
 * `NEXT_RELEASE` (INTENTIUS/chant#4480, packages/core/src/release-floors.ts),
 * so a local build stamped as chant stamps one meets every floor here.
 *
 * Everything that names that release reads this constant:
 *
 *  - the floors in src/chant-floors.ts (`ADOPTION_REPORT_CHANT_FLOOR`,
 *    `DRIFT_RECORD_CHANT_FLOOR`, `DRIFT_STREAM_CHANT_FLOOR`);
 *  - the pins and dependencies scripts/chant-release.ts writes: the
 *    three-cloud workspace's lexicon pins and package.json, the exact
 *    terraform lexicon pins of example-terraform-estate and
 *    example-choudoufu-estate, the pulumi-workspace fixture's pulumi lexicon
 *    pin, behold's own chant dependencies, and src/chant-drift-record.ts,
 *    which loads `@intentius/chant/drift-record`.
 *
 * The floors are `version` in both modes, so a local build stamped at
 * `version` meets every one. What `released` changes is how behold gets that
 * chant. While it is false, the dependency ranges and the exact lexicon pins
 * name the newest published chant ({@link PUBLISHED_CHANT}), so a plain
 * `npm ci` resolves and meets the pins (behold#1015); a demo copy and the e2e
 * scripts re-pin their copy at the lexicon installed beside behold, so a
 * local build still serves them. Flipping the switch moves the pins to
 * `version`, together with the floors. Also while it is false, the three-cloud
 * workspace pins its lexicons by path, the pulumi lexicon is no dependency
 * of anything (it is not on npm), and the drift module is feature-detected
 * at run time with behold's own copy as the fallback (src/drift-line.ts).
 * Once it is true, every range and exact pin names the release, the
 * three-cloud workspace pins both lexicons by package and version and
 * depends on them, and the drift module is a static import that the bundle
 * carries.
 *
 * To flip it after the release is published: set `released: true` (and
 * `version` to the release's number if it is not this one) on the line
 * below, run `npx tsx scripts/chant-release.ts`, then `npm install`.
 * `npx tsx scripts/chant-release.ts --check` fails when a written file
 * disagrees with this line (src/chant-release.test.ts runs it).
 */
export const CHANT_RELEASE = { version: "0.124.53", released: false } as const;

/** The newest chant on npm, the range a dependency keeps while {@link CHANT_RELEASE} is unreleased. */
export const PUBLISHED_CHANT = "0.124.52";
