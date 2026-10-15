import { output } from "@intentius/chant-lexicon-aws";
import { hostEip } from "./host";

// What the DNS record and the ops read: the address and its allocation.
export const elasticIp = output(hostEip.PublicIp, "ElasticIp");
export const elasticIpAllocationId = output(hostEip.AllocationId, "ElasticIpAllocationId");
