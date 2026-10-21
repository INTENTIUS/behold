import { FargateAlb, Parameter, output } from "@intentius/chant-lexicon-aws";

// The website on ECS Fargate in us-east-1, behind its own load balancer: the
// ALB's DNS name is the stable hostname Route 53 points at. The VPC and its
// subnets come in as parameters, so no networking is declared here.
export const vpcId = new Parameter("AWS::EC2::VPC::Id", { description: "The VPC (the default one is fine)" });
export const subnetIds = new Parameter("List<AWS::EC2::Subnet::Id>", { description: "Two public subnets in different zones" });

export const web = FargateAlb({
  image: "traefik/whoami:v1.10",
  containerPort: 80,
  desiredCount: 1,
  vpcId: vpcId as unknown as string,
  publicSubnetIds: subnetIds as unknown as string[],
  privateSubnetIds: subnetIds as unknown as string[],
  logRetentionDays: 7,
});

// The dns member reads this as its `awsEndpoint` parameter.
export const awsEndpoint = output(web.alb.DNSName, "awsEndpoint");
