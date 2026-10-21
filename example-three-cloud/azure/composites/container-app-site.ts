// A website on Azure Container Apps, set up the way a production environment
// is, as two composites: ContainerAppNetwork, the VNet with a subnet delegated
// to Container Apps, and ContainerAppSite, an environment in that subnet that
// ships its logs to a Log Analytics workspace, with an app running as a
// user-assigned identity.
// Container Apps brings its own ingress and load balancing, so there is no
// load balancer to declare.
//
// The body is a list of `const`s and a `return`, so `chant build` reads it
// rather than running it and records which argument fed which field.
import { Composite } from "@intentius/chant";
import { LogAnalyticsWorkspace, ManagedIdentity, Subnet, VirtualNetwork, managedEnvironments, containerApps } from "@intentius/chant-lexicon-azure";

export interface ContainerAppNetworkProps {
  /** The network is named `<name>-vnet`, its subnet `apps`. */
  name: string;
  location: string;
  addressSpace: string;
  /** The environment's subnet: a /23 or larger, delegated to Container Apps. */
  subnetPrefix: string;
}

/** The VNet a Container Apps environment sits in, with its delegated subnet. */
export const ContainerAppNetwork = Composite((props: ContainerAppNetworkProps) => {
  const vnet = new VirtualNetwork({ name: `${props.name}-vnet`, location: props.location, addressSpace: { addressPrefixes: [props.addressSpace] } });
  const subnet = new Subnet({
    name: `${props.name}-vnet/apps`,
    addressPrefix: props.subnetPrefix,
    delegations: [{ name: "apps", properties: { serviceName: "Microsoft.App/environments" } }],
  });
  return { vnet, subnet };
}, "ContainerAppNetwork");

export interface ContainerAppSiteProps {
  /** The environment's name; the workspace, network and identity are named after it. */
  name: string;
  /** The app's name. */
  app: string;
  location: string;
  /** The subnet the environment goes in: a ContainerAppNetwork's. */
  subnet: { id: string };
  image: string;
  /** The port the container listens on; ingress forwards to it. */
  port: number;
  replicas: number;
}

export const ContainerAppSite = Composite((props: ContainerAppSiteProps) => {
  const logs = new LogAnalyticsWorkspace({ name: `${props.name}-logs`, location: props.location, sku: { name: "PerGB2018" }, retentionInDays: 30 });
  const identity = new ManagedIdentity({ name: `${props.name}-${props.app}`, location: props.location });
  const env = new managedEnvironments({
    name: props.name,
    location: props.location,
    vnetConfiguration: { infrastructureSubnetId: props.subnet.id, internal: false },
    appLogsConfiguration: {
      destination: "log-analytics",
      logAnalyticsConfiguration: {
        customerId: `[reference(resourceId('Microsoft.OperationalInsights/workspaces', '${props.name}-logs')).customerId]`,
        sharedKey: `[listKeys(resourceId('Microsoft.OperationalInsights/workspaces', '${props.name}-logs'), '2023-09-01').primarySharedKey]`,
      },
    },
    workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }],
  });
  const app = new containerApps({
    name: props.app,
    location: props.location,
    identity: { type: "UserAssigned", userAssignedIdentities: { [`[resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', '${props.name}-${props.app}')]`]: {} } },
    managedEnvironmentId: env.id,
    workloadProfileName: "Consumption",
    configuration: { ingress: { external: true, targetPort: props.port, transport: "auto" } },
    template: {
      containers: [{ name: props.app, image: props.image, resources: { cpu: 0.25, memory: "0.5Gi" } }],
      scale: { minReplicas: props.replicas, maxReplicas: props.replicas },
    },
  });
  return { logs, identity, env, app };
}, "ContainerAppSite");
