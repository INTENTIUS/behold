import {
  Bucket,
  Bucket_PublicAccessBlockConfiguration,
  Bucket_BucketEncryption,
  Bucket_ServerSideEncryptionRule,
  Bucket_ServerSideEncryptionByDefault,
  S3BucketPolicy,
  Ref,
} from "@intentius/chant-lexicon-aws";

// One S3 bucket — the whole "infra" for behold's first-apply demo. With
// `behold serve … --local` this deploys to the local Floci emulator (no cloud
// creds); against a real account, change BucketName to something globally unique.
export const store = new Bucket({
  BucketName: "behold-floci-demo",
  PublicAccessBlockConfiguration: new Bucket_PublicAccessBlockConfiguration({
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  }),
  // Server-side encryption (WAW006).
  BucketEncryption: new Bucket_BucketEncryption({
    ServerSideEncryptionConfiguration: [
      new Bucket_ServerSideEncryptionRule({
        ServerSideEncryptionByDefault: new Bucket_ServerSideEncryptionByDefault({ SSEAlgorithm: "AES256" }),
      }),
    ],
  }),
});

// Deny non-TLS access (WAW042). Both values are hoisted to consts so they're plain
// identifier references in the constructor (EVL001 forbids call expressions and
// inline objects as property values). `Ref(store)` ties the policy to `store` by
// logical id, which is how WAW042 matches policy → bucket.
const storeRef = Ref(store);
const denyInsecureTransport = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "DenyInsecureTransport",
      Effect: "Deny",
      Principal: "*",
      Action: "s3:*",
      Resource: ["arn:aws:s3:::behold-floci-demo", "arn:aws:s3:::behold-floci-demo/*"],
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    },
  ],
};

export const storePolicy = new S3BucketPolicy({
  Bucket: storeRef,
  PolicyDocument: denyInsecureTransport,
});
