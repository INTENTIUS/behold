// A website on Cloud Run behind a global external Application Load Balancer,
// set up the way production is, as two composites: PrivateEgressNetwork, a
// custom VPC with a subnet for the service's egress, and PublicCloudRun, the
// service running as its own service account and reached through a
// reserved address, a forwarding rule, an HTTP proxy, a URL map, a backend
// service and a serverless network endpoint group that names it.
//
// The body is a list of `const`s and a `return`, so `chant build` reads it
// rather than running it and records which argument fed which field.
import { Composite } from "@intentius/chant";
import {
  BackendService,
  CloudRunServiceComposite,
  ComputeAddress,
  ForwardingRule,
  GCPServiceAccount,
  RegionNetworkEndpointGroup,
  Subnetwork,
  TargetHTTPProxy,
  URLMap,
  VPCNetwork,
} from "@intentius/chant-lexicon-gcp";

export interface PrivateEgressNetworkProps {
  /** The network is named `<name>-vpc`, its subnet `<name>-apps`. */
  name: string;
  region: string;
  /** The subnet a service's egress goes into. */
  subnetCidr: string;
}

/** A custom-mode VPC with one subnet in the region a service sends its egress into. */
export const PrivateEgressNetwork = Composite((props: PrivateEgressNetworkProps) => {
  const vpc = new VPCNetwork({ metadata: { name: `${props.name}-vpc` }, autoCreateSubnetworks: false, routingMode: "REGIONAL" });
  const subnet = new Subnetwork({ metadata: { name: `${props.name}-apps` }, region: props.region, ipCidrRange: props.subnetCidr, networkRef: { name: vpc.name } });
  return { vpc, subnet };
}, "PrivateEgressNetwork");

export interface PublicCloudRunProps {
  /** The prefix every resource is named with. */
  name: string;
  project: string;
  region: string;
  /** The network its egress goes into: a PrivateEgressNetwork's VPC and subnet. */
  vpc: { name: string };
  subnet: { name: string };
  image: string;
  /** The port the container listens on. */
  port: number;
  instances: number;
}

export const PublicCloudRun = Composite((props: PublicCloudRunProps) => {
  const runtime = new GCPServiceAccount({ metadata: { name: `${props.name}-run` }, displayName: `${props.name} website runtime` });
  const run = CloudRunServiceComposite({
    name: `${props.name}-site`,
    image: props.image,
    projectId: props.project,
    location: props.region,
    port: props.port,
    minInstanceCount: props.instances,
    maxInstanceCount: props.instances,
    publicAccess: true,
    serviceAccount: `${props.name}-run`,
    defaults: {
      service: {
        template: {
          vpcAccess: { egress: "PRIVATE_RANGES_ONLY", networkInterfaces: [{ networkRef: { name: props.vpc.name }, subnetworkRef: { name: props.subnet.name } }] },
        },
      },
    },
  });
  const service = run.service;
  const publicAccess = run.publicIam;
  const neg = new RegionNetworkEndpointGroup({
    metadata: { name: `${props.name}-neg` },
    region: props.region,
    networkEndpointType: "SERVERLESS",
    cloudRun: { serviceRef: { name: service.name } },
  });
  // A backend service over a serverless NEG takes no health check: Cloud Run
  // reports its own readiness.
  const backend = new BackendService({
    metadata: { name: `${props.name}-backend` },
    location: "global",
    loadBalancingScheme: "EXTERNAL_MANAGED",
    protocol: "HTTP",
    backend: [{ group: { networkEndpointGroupRef: { name: neg.name } } }],
  });
  const urlMap = new URLMap({ metadata: { name: `${props.name}-map` }, location: "global", defaultService: { backendServiceRef: { name: backend.name } } });
  const proxy = new TargetHTTPProxy({ metadata: { name: `${props.name}-proxy` }, location: "global", urlMapRef: { name: urlMap.name } });
  const address = new ComputeAddress({ metadata: { name: `${props.name}-ip` }, location: "global" });
  const rule = new ForwardingRule({
    metadata: { name: `${props.name}-rule` },
    location: "global",
    loadBalancingScheme: "EXTERNAL_MANAGED",
    portRange: String(props.port),
    ipAddress: { addressRef: { name: address.name } },
    target: { targetHTTPProxyRef: { name: proxy.name } },
  });
  return { runtime, service, publicAccess, neg, backend, urlMap, proxy, address, rule };
}, "PublicCloudRun");
