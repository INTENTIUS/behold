/**
 * behold#1005: the chant release behold's newest reads need, set in one place.
 *
 * `version` is the chant release behold depends on. 0.124.54 was the first
 * release with the drift record and its stream, the adoption report,
 * `member-outputs` and the pulumi lexicon.
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
// Each train publishes only the members that changed. 0.124.105 is core with chant's `templateCatalog(dir)` (behold#1142); the k8s and aws
// lexicons that need it are 0.124.104, and the others stay where their last train left them, each with a peer range on chant that takes 0.124.105.
// 0.124.107 is the chant behold releases its products with as one train (behold#1211). 0.124.110 is the chant the delivery epic's
// reads land on (behold#1227, behold#1228, behold#1236). 0.124.118 is core with ECS tasks owned by their service's node id on a named
// stack (chant#5490), read by the aws lexicon 0.124.107 (behold#1250). 0.124.120 changes no read behold makes; behold follows it so its
// products release on the current chant, and the gcp lexicon 0.124.104 keeps its published names stable. 0.124.121 is core whose
// release verify accepts a cut signed through Sigstore alone and whose npm reveal tries the signature audit again after a fetch error;
// the k8s, gcp and pulumi lexicons 0.124.105 keep published names stable and hold a Pulumi plan digest across previews. 0.124.122 is
// core whose release verify --sigstore checks an npm package's registry provenance; the k8s lexicon 0.126.0 is Kubernetes v1.37.2, where
// a Deployment, DaemonSet, StatefulSet and ReplicaSet need `spec`, and the gcp lexicon 0.126.0 is the v1.162.0 schemas.
export const CHANT_RELEASE = {
  version: "0.124.122",
  released: true,
  lexicons: {
    "@intentius/chant-lexicon-k8s": "0.126.0",
    "@intentius/chant-lexicon-aws": "0.124.108",
    "@intentius/chant-lexicon-gcp": "0.126.0",
    "@intentius/chant-lexicon-otel": "0.124.102",
    "@intentius/chant-lexicon-prometheus": "0.124.101",
    "@intentius/chant-lexicon-pulumi": "0.124.105",
    "@intentius/chant-lexicon-sql": "0.124.103",
    "@intentius/chant-lexicon-terraform": "0.124.104",
    "@intentius/chant-k8s-client": "0.124.101",
  },
} as const;

/** The newest chant on npm, the range a dependency keeps while {@link CHANT_RELEASE} is unreleased. */
export const PUBLISHED_CHANT = "0.124.58";
