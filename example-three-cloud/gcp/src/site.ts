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
  output,
} from "@intentius/chant-lexicon-gcp";

// The website on Cloud Run in Tokyo, running as its own service account with
// its egress in a VPC subnet, behind a global external Application Load
// Balancer as production sets it up: a
// static address and a forwarding rule, an HTTP proxy, a URL map, a backend
// service, and a serverless network endpoint group that names the service.
const region = "asia-northeast1";

export const runtime = new GCPServiceAccount({
  metadata: { name: "three-cloud-run" },
  displayName: "three-cloud website runtime",
});

// The network Cloud Run sends its egress into (Direct VPC egress), a custom
// VPC with one subnet in the service's region.
export const vpc = new VPCNetwork({ metadata: { name: "three-cloud-vpc" }, autoCreateSubnetworks: false, routingMode: "REGIONAL" });

export const subnet = new Subnetwork({
  metadata: { name: "three-cloud-apps" },
  region,
  ipCidrRange: "10.30.0.0/24",
  networkRef: { name: vpc.name },
});

export const web = CloudRunServiceComposite({
  name: "three-cloud-site",
  image: "traefik/whoami:v1.10",
  projectId: "three-cloud",
  location: region,
  port: 80,
  minInstanceCount: 1,
  maxInstanceCount: 1,
  publicAccess: true,
  serviceAccount: "three-cloud-run",
  defaults: {
    service: {
      template: {
        vpcAccess: {
          egress: "PRIVATE_RANGES_ONLY",
          networkInterfaces: [{ networkRef: { name: vpc.name }, subnetworkRef: { name: subnet.name } }],
        },
      },
    },
  },
});

export const neg = new RegionNetworkEndpointGroup({
  metadata: { name: "three-cloud-neg" },
  region,
  networkEndpointType: "SERVERLESS",
  cloudRun: { serviceRef: { name: web.service.name } },
});

// A backend service over a serverless NEG takes no health check: Cloud Run
// reports its own readiness.
export const backend = new BackendService({
  metadata: { name: "three-cloud-backend" },
  location: "global",
  loadBalancingScheme: "EXTERNAL_MANAGED",
  protocol: "HTTP",
  backend: [{ group: { networkEndpointGroupRef: { name: neg.name } } }],
});

export const urlMap = new URLMap({
  metadata: { name: "three-cloud-map" },
  location: "global",
  defaultService: { backendServiceRef: { name: backend.name } },
});

export const proxy = new TargetHTTPProxy({
  metadata: { name: "three-cloud-proxy" },
  location: "global",
  urlMapRef: { name: urlMap.name },
});

export const address = new ComputeAddress({ metadata: { name: "three-cloud-ip" }, location: "global" });

export const rule = new ForwardingRule({
  metadata: { name: "three-cloud-rule" },
  location: "global",
  loadBalancingScheme: "EXTERNAL_MANAGED",
  portRange: "80",
  ipAddress: { addressRef: { name: address.name } },
  target: { targetHTTPProxyRef: { name: proxy.name } },
});

// The dns member reads this as its `gcpEndpoint` parameter: the load
// balancer's front end, whose IP is the reserved address. Config Connector
// YAML has no outputs and neither kind exposes the IP as an attribute, so
// this declares the join for the graph, and scripts/front-door.ts reads the
// IP from the emulator.
export const gcpEndpoint = output(rule.status_selfLink, "gcpEndpoint");
