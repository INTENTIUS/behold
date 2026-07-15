import { Bucket, Bucket_PublicAccessBlockConfiguration, S3BucketPolicy, Ref } from "@intentius/chant-lexicon-aws";

// One S3 bucket — the whole "infra" for behold's first-apply demo. With
// `behold serve … --local` this deploys to the local Floci emulator (no cloud
// creds); against a real account, change BucketName to something globally unique.
const bucketName = "behold-floci-demo";

export const store = new Bucket({
  BucketName: bucketName,
  PublicAccessBlockConfiguration: new Bucket_PublicAccessBlockConfiguration({
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  }),
});

// Deny non-TLS access (WAW042) — a bucket without this fails the security lint,
// so the apply never builds. This keeps the demo deploy-clean.
export const storePolicy = new S3BucketPolicy({
  // Ref (not the name string) so the TLS-deny lint (WAW042) ties this policy to
  // the `store` bucket by logical id.
  Bucket: Ref(store),
  PolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyInsecureTransport",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [`arn:aws:s3:::${bucketName}`, `arn:aws:s3:::${bucketName}/*`],
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      },
    ],
  },
});
