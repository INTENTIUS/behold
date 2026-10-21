import { FargateAlb, VpcDefault, output } from "@intentius/chant-lexicon-aws";

// The website on ECS Fargate in us-east-1, behind its own load balancer: the
// ALB's DNS name is the stable hostname Route 53 points at. The network is
// declared here as production has it: a VPC across two zones, public subnets
// for the load balancer and private ones for the tasks, which reach out
// through a NAT gateway.
export const network = VpcDefault({
  cidr: "10.20.0.0/16",
  publicSubnet1Cidr: "10.20.0.0/24",
  publicSubnet2Cidr: "10.20.1.0/24",
  privateSubnet1Cidr: "10.20.10.0/24",
  privateSubnet2Cidr: "10.20.11.0/24",
});

export const web = FargateAlb({
  image: "traefik/whoami:v1.10",
  containerPort: 80,
  desiredCount: 1,
  vpcId: network.vpc.VpcId,
  publicSubnetIds: [network.publicSubnet1.SubnetId, network.publicSubnet2.SubnetId],
  privateSubnetIds: [network.privateSubnet1.SubnetId, network.privateSubnet2.SubnetId],
  logRetentionDays: 7,
});

// The dns member reads this as its `awsEndpoint` parameter.
export const awsEndpoint = output(web.alb.DNSName, "awsEndpoint");
