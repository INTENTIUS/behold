import { Bucket, Bucket_PublicAccessBlockConfiguration } from "@intentius/chant-lexicon-aws";

// One cheap, free-tier S3 bucket — real apply target for behold's Sync demo.
// CHANGE THIS: S3 bucket names are globally unique. Use your own (your AWS
// account id or a random suffix). See README.md.
export const store = new Bucket({
  BucketName: "behold-sync-CHANGE-ME-demo",
  PublicAccessBlockConfiguration: new Bucket_PublicAccessBlockConfiguration({
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  }),
});
