import { CloudRunServiceComposite, GCPServiceAccount, output } from "@intentius/chant-lexicon-gcp";

// The website on Cloud Run in Tokyo, open to unauthenticated callers, running
// as its own service account rather than the project's default one. Cloud Run
// brings its own HTTPS endpoint and load balancing. Production often puts an
// external Application Load Balancer in front (serverless NEG, backend
// service, URL map, proxy, forwarding rule); the emulator can't run that yet
// (lex00/floci-gcp#27), so the service's own endpoint is what Route 53 points at.
export const runtime = new GCPServiceAccount({
  metadata: { name: "three-cloud-run" },
  displayName: "three-cloud website runtime",
});

export const web = CloudRunServiceComposite({
  name: "web",
  image: "traefik/whoami:v1.10",
  projectId: "three-cloud",
  location: "asia-northeast1",
  port: 80,
  minInstanceCount: 1,
  maxInstanceCount: 1,
  publicAccess: true,
  defaults: { service: { template: { serviceAccountRef: { name: "three-cloud-run" } } } },
});

// The dns member reads this as its `gcpEndpoint` parameter. Config Connector
// YAML has no outputs, so `chant build` warns that this one is not written:
// the graph still joins it to dns, and scripts/front-door.ts reads the URI
// from the emulator to pass it on.
export const gcpEndpoint = output(web.service.status_uri, "gcpEndpoint");
