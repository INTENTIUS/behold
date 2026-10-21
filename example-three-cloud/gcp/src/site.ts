import {
  BackendService,
  CloudRunServiceComposite,
  ComputeAddress,
  ForwardingRule,
  GCPServiceAccount,
  RegionNetworkEndpointGroup,
  TargetHTTPProxy,
  URLMap,
  output,
} from "@intentius/chant-lexicon-gcp";

// The website on Cloud Run in Tokyo, running as its own service account, behind
// a global external Application Load Balancer as production sets it up: a
// static address and a forwarding rule, an HTTP proxy, a URL map, a backend
// service, and a serverless network endpoint group that names the service.
// The load balancer kinds apply with chant 0.124.35 or newer (chant#4233).
//
// Each reference is Config Connector's `{ name }`, spelled out: chant writes
// an attribute reference's `.name` as the logical id rather than the
// resource's metadata.name (reported to chant).
const region = "asia-northeast1";

export const runtime = new GCPServiceAccount({
  metadata: { name: "three-cloud-run" },
  displayName: "three-cloud website runtime",
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
});

export const neg = new RegionNetworkEndpointGroup({
  metadata: { name: "three-cloud-neg" },
  region,
  networkEndpointType: "SERVERLESS",
  cloudRun: { serviceRef: { name: "three-cloud-site" } },
});

// A backend service over a serverless NEG takes no health check: Cloud Run
// reports its own readiness.
export const backend = new BackendService({
  metadata: { name: "three-cloud-backend" },
  location: "global",
  loadBalancingScheme: "EXTERNAL_MANAGED",
  protocol: "HTTP",
  backend: [{ group: { networkEndpointGroupRef: { name: "three-cloud-neg" } } }],
});

export const urlMap = new URLMap({
  metadata: { name: "three-cloud-map" },
  location: "global",
  defaultService: { backendServiceRef: { name: "three-cloud-backend" } },
});

export const proxy = new TargetHTTPProxy({
  metadata: { name: "three-cloud-proxy" },
  location: "global",
  urlMapRef: { name: "three-cloud-map" },
});

export const address = new ComputeAddress({ metadata: { name: "three-cloud-ip" }, location: "global" });

export const rule = new ForwardingRule({
  metadata: { name: "three-cloud-rule" },
  location: "global",
  loadBalancingScheme: "EXTERNAL_MANAGED",
  portRange: "80",
  ipAddress: { addressRef: { name: "three-cloud-ip" } },
  target: { targetHTTPProxyRef: { name: "three-cloud-proxy" } },
});

// The dns member reads this as its `gcpEndpoint` parameter: the load
// balancer's front end, whose IP is the reserved address. Config Connector
// YAML has no outputs and neither kind exposes the IP as an attribute, so
// this declares the join for the graph, and scripts/front-door.ts reads the
// IP from the emulator.
export const gcpEndpoint = output(rule.status_selfLink, "gcpEndpoint");
