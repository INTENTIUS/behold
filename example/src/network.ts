import { VpcDefault } from "@intentius/chant-lexicon-aws";

// A VPC + public/private subnets — a handful of AWS resources with real
// references (subnet → VPC), so the graph has cross-resource edges to keep
// under the source-anchored overlay.
export const network = VpcDefault({});
