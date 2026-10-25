// The three-cloud demo's aws member (INTENTIUS/behold#1000): the website on
// ECS Fargate in us-east-1, behind its own load balancer, as a Pulumi program
// that plunge runs. The ALB's DNS name is the stable hostname Route 53 points
// at, published as the stack output `awsEndpoint`, which the dns member reads
// through chant (memberOutputsComponent("aws"), stackOutput("aws",
// "awsEndpoint")).
//
// The resources are the ones the chant aws member declared before this
// program replaced it: the aws lexicon's VpcDefault (a VPC across two zones,
// public subnets for the load balancer, private ones for the tasks, a NAT
// gateway they reach out through) and FargateAlb (cluster, roles, log group,
// task definition, security groups, load balancer, target group, listener,
// service), with the same arguments. Logical names are the chant member's
// entity names in kebab case.
//
// Every call goes to floci. The provider is explicit, every resource and
// invoke names it, and its endpoint is AWS_ENDPOINT_URL (default
// http://localhost:4566), refused unless it is on this machine. The key pair
// is floci's fake one and the skip flags stop the provider calling STS or the
// metadata service, as the plunge corpus's stacks do
// (plunge tests/plunge-corpus/aws-ts).
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const host = new URL(endpoint).hostname;
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
  throw new Error(`three-cloud-aws runs only against an emulator on this machine; AWS_ENDPOINT_URL names ${endpoint}`);
}

const floci = new aws.Provider("floci", {
  region: "us-east-1",
  accessKey: "test",
  secretKey: "test",
  skipCredentialsValidation: true,
  skipRequestingAccountId: true,
  skipRegionValidation: true,
  skipMetadataApiCheck: true,
  endpoints: [{
    ec2: endpoint,
    ecs: endpoint,
    elbv2: endpoint,
    iam: endpoint,
    logs: endpoint,
    sts: endpoint,
  }],
});
const opts = { provider: floci };

// ── the network (VpcDefault) ────────────────────────────────────────────────

const zones = aws.getAvailabilityZonesOutput({ state: "available" }, opts);
const az1 = zones.names[0];
const az2 = zones.names[1];

const vpc = new aws.ec2.Vpc("network-vpc", { cidrBlock: "10.20.0.0/16", enableDnsSupport: true, enableDnsHostnames: true }, opts);
const igw = new aws.ec2.InternetGateway("network-igw", {}, opts);
const igwAttachment = new aws.ec2.InternetGatewayAttachment("network-igw-attachment", { vpcId: vpc.id, internetGatewayId: igw.id }, opts);

const publicSubnet1 = new aws.ec2.Subnet("network-public-subnet-1", { vpcId: vpc.id, cidrBlock: "10.20.0.0/24", availabilityZone: az1, mapPublicIpOnLaunch: true }, opts);
const publicSubnet2 = new aws.ec2.Subnet("network-public-subnet-2", { vpcId: vpc.id, cidrBlock: "10.20.1.0/24", availabilityZone: az2, mapPublicIpOnLaunch: true }, opts);
const privateSubnet1 = new aws.ec2.Subnet("network-private-subnet-1", { vpcId: vpc.id, cidrBlock: "10.20.10.0/24", availabilityZone: az1 }, opts);
const privateSubnet2 = new aws.ec2.Subnet("network-private-subnet-2", { vpcId: vpc.id, cidrBlock: "10.20.11.0/24", availabilityZone: az2 }, opts);

const publicRouteTable = new aws.ec2.RouteTable("network-public-route-table", { vpcId: vpc.id }, opts);
new aws.ec2.Route("network-public-route", { routeTableId: publicRouteTable.id, destinationCidrBlock: "0.0.0.0/0", gatewayId: igw.id }, { ...opts, dependsOn: [igwAttachment] });
new aws.ec2.RouteTableAssociation("network-public-rta-1", { subnetId: publicSubnet1.id, routeTableId: publicRouteTable.id }, opts);
new aws.ec2.RouteTableAssociation("network-public-rta-2", { subnetId: publicSubnet2.id, routeTableId: publicRouteTable.id }, opts);

const natEip = new aws.ec2.Eip("network-nat-eip", { domain: "vpc" }, opts);
const natGateway = new aws.ec2.NatGateway("network-nat-gateway", { allocationId: natEip.id, subnetId: publicSubnet1.id }, opts);

const privateRouteTable = new aws.ec2.RouteTable("network-private-route-table", { vpcId: vpc.id }, opts);
new aws.ec2.Route("network-private-route", { routeTableId: privateRouteTable.id, destinationCidrBlock: "0.0.0.0/0", natGatewayId: natGateway.id }, opts);
new aws.ec2.RouteTableAssociation("network-private-rta-1", { subnetId: privateSubnet1.id, routeTableId: privateRouteTable.id }, opts);
new aws.ec2.RouteTableAssociation("network-private-rta-2", { subnetId: privateSubnet2.id, routeTableId: privateRouteTable.id }, opts);

// ── the website (FargateAlb) ────────────────────────────────────────────────

const containerPort = 80;
const ecsTrustPolicy = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole" }],
});

const cluster = new aws.ecs.Cluster("web-cluster", {}, opts);

// Execution role: ECR pull and CloudWatch Logs write.
const executionRole = new aws.iam.Role("web-execution-role", {
  assumeRolePolicy: ecsTrustPolicy,
  inlinePolicies: [{
    name: "ExecutionPolicy",
    policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: ["ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource: "*" },
        { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" },
      ],
    }),
  }],
}, opts);

// Task role: the app's own permissions, none here.
const taskRole = new aws.iam.Role("web-task-role", { assumeRolePolicy: ecsTrustPolicy }, opts);

// Named, so an out-of-band edit (scripts/front-door.ts oob-edit aws) can find it.
const logGroup = new aws.cloudwatch.LogGroup("web-log-group", { name: "/ecs/three-cloud-aws-web", retentionInDays: 7 }, opts);

const taskDef = new aws.ecs.TaskDefinition("web-task-def", {
  family: "three-cloud-aws-web",
  networkMode: "awsvpc",
  requiresCompatibilities: ["FARGATE"],
  cpu: "256",
  memory: "512",
  executionRoleArn: executionRole.arn,
  taskRoleArn: taskRole.arn,
  containerDefinitions: pulumi.jsonStringify([{
    name: "app",
    image: "traefik/whoami:v1.10",
    essential: true,
    portMappings: [{ containerPort, protocol: "tcp" }],
    logConfiguration: {
      logDriver: "awslogs",
      options: { "awslogs-group": logGroup.name, "awslogs-region": "us-east-1", "awslogs-stream-prefix": "ecs" },
    },
  }]),
}, opts);

const albSg = new aws.ec2.SecurityGroup("web-alb-sg", {
  description: "ALB security group",
  vpcId: vpc.id,
  ingress: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] }],
}, opts);

const taskSg = new aws.ec2.SecurityGroup("web-task-sg", {
  description: "Fargate task security group",
  vpcId: vpc.id,
  ingress: [{ protocol: "tcp", fromPort: containerPort, toPort: containerPort, securityGroups: [albSg.id] }],
}, opts);

const alb = new aws.lb.LoadBalancer("web-alb", {
  loadBalancerType: "application",
  internal: false,
  subnets: [publicSubnet1.id, publicSubnet2.id],
  securityGroups: [albSg.id],
}, opts);

const targetGroup = new aws.lb.TargetGroup("web-target-group", {
  targetType: "ip",
  protocol: "HTTP",
  port: containerPort,
  vpcId: vpc.id,
  healthCheck: { path: "/" },
}, opts);

const listener = new aws.lb.Listener("web-listener", {
  loadBalancerArn: alb.arn,
  port: 80,
  protocol: "HTTP",
  defaultActions: [{ type: "forward", targetGroupArn: targetGroup.arn }],
}, opts);

new aws.ecs.Service("web-service", {
  cluster: cluster.arn,
  taskDefinition: taskDef.arn,
  launchType: "FARGATE",
  desiredCount: 1,
  healthCheckGracePeriodSeconds: 60,
  loadBalancers: [{ containerName: "app", containerPort, targetGroupArn: targetGroup.arn }],
  networkConfiguration: { subnets: [privateSubnet1.id, privateSubnet2.id], securityGroups: [taskSg.id], assignPublicIp: false },
}, { ...opts, dependsOn: [listener] });

// The dns member reads this as its `awsEndpoint` parameter.
export const awsEndpoint = alb.dnsName;
