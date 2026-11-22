import { Bucket } from "@intentius/chant-lexicon-aws";

// The shop estate's two buckets. `exports` is also declared by the analytics
// estate under the same name, which is the claim the merge view shows as shared.
export const assets = new Bucket({ BucketName: "acme-shop-assets-7f3a" });
export const exportsBucket = new Bucket({ BucketName: "acme-shared-exports-91c2" });
