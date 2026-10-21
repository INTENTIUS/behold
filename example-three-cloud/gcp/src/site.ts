import { CloudRunServiceComposite, output } from "@intentius/chant-lexicon-gcp";

// The website on Cloud Run in Tokyo, open to unauthenticated callers.
export const web = CloudRunServiceComposite({
  name: "web",
  image: "traefik/whoami:v1.10",
  projectId: "three-cloud",
  location: "asia-northeast1",
  port: 80,
  minInstanceCount: 1,
  maxInstanceCount: 1,
  publicAccess: true,
});

// The dns member reads this as its `gcpEndpoint` parameter. Config Connector
// YAML has no outputs, so `chant build` warns that this one is not written:
// the graph still joins it to dns, and scripts/front-door.ts reads the URI
// from the emulator to pass it on.
export const gcpEndpoint = output(web.service.status_uri, "gcpEndpoint");
