import { Bucket } from "@intentius/chant-lexicon-aws";

// The analytics estate's own warehouse, and the exports bucket the shop estate
// declares too: one cloud id, two estates claiming it.
export const warehouse = new Bucket({ BucketName: "acme-analytics-warehouse-44d0" });
export const exportsBucket = new Bucket({ BucketName: "acme-shared-exports-91c2" });
