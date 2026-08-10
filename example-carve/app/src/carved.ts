import { LogGroup, SsmParameter } from "@intentius/chant-lexicon-aws";

// These two came out of ../legacy-tf last month, in the first pass of the
// migration. Both were carved the same way:
//
//   chant carve emit --from ../legacy-tf --state ../legacy-tf/terraform.tfstate \
//     --select aws_cloudwatch_log_group.api --output .
//   terraform state rm aws_cloudwatch_log_group.api
//
// Neither was destroyed or recreated — `carve emit` adopts the live resource at
// the observe position, and the `state rm` only drops Terraform's claim on it.
// The estate has been mixed ever since: chant owns these, Terraform still owns
// the bucket, the API lambda and the whole VPC block next door.

// The API lambda's log group. Terraform created it (the retention was already
// 30 days); chant has owned it since the carve.
export const apiLogs = new LogGroup({
  LogGroupName: "/acme/platform/api",
  RetentionInDays: 30,
});

// Was `aws_ssm_parameter.assets_cdn_domain` in ../legacy-tf. The surviving
// Terraform reads it back through a `data "aws_ssm_parameter"` block — the
// data-source patch `carve bridge` writes for every inbound edge a carve cuts.
export const assetsCdnDomain = new SsmParameter({
  Name: "/acme/platform/prod/assets-cdn-domain",
  Type: "String",
  Value: "cdn.acme-platform.example.com",
  Description: "Public hostname the CDN serves acme-platform's static assets on.",
});
