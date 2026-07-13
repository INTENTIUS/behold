import { Bucket, Bucket_PublicAccessBlockConfiguration } from "@intentius/chant-lexicon-aws";

// One cheap, free-tier S3 bucket — real apply target for behold's Sync demo.
export const store = new Bucket({
  BucketName: "behold-sync-354867293429-demo",
  PublicAccessBlockConfiguration: new Bucket_PublicAccessBlockConfiguration({
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  }),
});
