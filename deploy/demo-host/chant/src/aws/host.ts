// The demo host's AWS resources (#570, tracked in #571), us-east-2, account
// 354867293429. They were made by hand on 2026-10-15 and brought under the
// CloudFormation stack demo-intentius-host by resource import, so every
// property here is the value the live resource already had: a property that
// differed would show as an update in the next change set.
//
// Every resource is Retain on delete and on replace. Removing one from this
// file, or deleting the stack, leaves the resource in the account; a change
// that would replace the instance or the Elastic IP keeps the old one.
//
// The default VPC and its subnet are the account's, not this stack's: they
// are named by id. The root volume is the instance's (BlockDeviceMappings);
// a volume isn't a resource of its own here.
import { EIP, EIPAssociation, Instance, KeyPair, SecurityGroup } from "@intentius/chant-lexicon-aws";

const retain = { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" } as const;

const project = { Key: "Project", Value: "behold-571" };

/** The default VPC in us-east-2, and the us-east-2c subnet the instance is in. */
export const vpcId = "vpc-42e9e02a";
export const subnetId = "subnet-cbe33587";

/** The operator's address, the only one ssh is open to. */
export const operatorCidr = "73.14.154.133/32";

/** The ssh key the instance was launched with: ed25519, the public half only. */
export const demoKeyPair = new KeyPair(
  {
    KeyName: "demo-intentius",
    KeyType: "ed25519",
    PublicKeyMaterial:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBZV6IyTcqViNJ8+0g+kb+QgTj6hYRPsx5NfDsJBshb2 demo-intentius",
    Tags: [project, { Key: "Name", Value: "demo-intentius" }],
  },
  retain,
);

/** 443 and 80 from anywhere for Caddy, 22 from the operator only. */
export const hostSecurityGroup = new SecurityGroup(
  {
    GroupName: "demo-intentius-host",
    GroupDescription: "demo.intentius.io: 80/443 public, 22 from the operator",
    VpcId: vpcId,
    SecurityGroupIngress: [
      { IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0", Description: "site" },
      { IpProtocol: "tcp", FromPort: 80, ToPort: 80, CidrIp: "0.0.0.0/0", Description: "acme-and-redirect" },
      { IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: operatorCidr, Description: "operator" },
    ],
    SecurityGroupEgress: [{ IpProtocol: "-1", CidrIp: "0.0.0.0/0" }],
    Tags: [project, { Key: "Name", Value: "demo-intentius-host" }],
  },
  retain,
);

/**
 * c7i.xlarge, Ubuntu 24.04 (ubuntu-noble-24.04-amd64-server-20261004), a 60 GB
 * gp3 root, IMDSv2 only, no instance profile: nothing on it holds AWS
 * credentials.
 */
export const hostInstance = new Instance(
  {
    ImageId: "ami-09519cc56eb20524a",
    InstanceType: "c7i.xlarge",
    KeyName: demoKeyPair,
    SubnetId: subnetId,
    SecurityGroupIds: [hostSecurityGroup.GroupId],
    BlockDeviceMappings: [
      {
        DeviceName: "/dev/sda1",
        Ebs: { VolumeSize: 60, VolumeType: "gp3", DeleteOnTermination: true },
      },
    ],
    MetadataOptions: {
      HttpTokens: "required",
      HttpEndpoint: "enabled",
      HttpPutResponseHopLimit: 2,
      HttpProtocolIpv6: "disabled",
      InstanceMetadataTags: "disabled",
    },
    Tags: [project, { Key: "Name", Value: "demo-intentius" }],
  },
  retain,
);

/** 77.114.54.88, the address demo.intentius.io's A record names. */
export const hostEip = new EIP(
  {
    Domain: "vpc",
    Tags: [project, { Key: "Name", Value: "demo-intentius" }],
  },
  retain,
);

export const hostEipAssociation = new EIPAssociation(
  {
    AllocationId: hostEip.AllocationId,
    InstanceId: hostInstance.InstanceId,
  },
  retain,
);
