import { LogAnalyticsWorkspace, ManagedIdentity, VirtualNetwork, managedEnvironments, containerApps, output } from "@intentius/chant-lexicon-azure";

// The website on Azure Container Apps in West Europe, set up the way a
// production environment is: the environment sits in its own VNet subnet and
// ships its logs to a Log Analytics workspace, and the app runs as a
// user-assigned identity. Container Apps brings its own ingress and load
// balancing, so there is no load balancer to declare.
const location = "westeurope";

export const logs = new LogAnalyticsWorkspace({ name: "three-cloud-logs", location, sku: { name: "PerGB2018" }, retentionInDays: 30 });

// A Container Apps environment on workload profiles takes a /23 or larger,
// delegated to it. The subnet is declared inside the VNet: chant's own Subnet
// resource writes the ARM type as virtualNetworks_subnets (reported to chant).
export const vnet = new VirtualNetwork({
  name: "three-cloud-vnet",
  location,
  addressSpace: { addressPrefixes: ["10.40.0.0/16"] },
  subnets: [{ name: "apps", properties: { addressPrefix: "10.40.0.0/23", delegations: [{ name: "apps", properties: { serviceName: "Microsoft.App/environments" } }] } }],
});

export const identity = new ManagedIdentity({ name: "three-cloud-web", location });

export const env = new managedEnvironments({
  name: "three-cloud",
  location,
  vnetConfiguration: { infrastructureSubnetId: "[resourceId('Microsoft.Network/virtualNetworks/subnets', 'three-cloud-vnet', 'apps')]", internal: false },
  appLogsConfiguration: {
    destination: "log-analytics",
    logAnalyticsConfiguration: {
      customerId: "[reference(resourceId('Microsoft.OperationalInsights/workspaces', 'three-cloud-logs')).customerId]",
      sharedKey: "[listKeys(resourceId('Microsoft.OperationalInsights/workspaces', 'three-cloud-logs'), '2023-09-01').primarySharedKey]",
    },
  },
  workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }],
});

export const app = new containerApps({
  name: "web",
  location,
  identity: { type: "UserAssigned", userAssignedIdentities: { "[resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', 'three-cloud-web')]": {} } },
  managedEnvironmentId: env.id,
  workloadProfileName: "Consumption",
  configuration: { ingress: { external: true, targetPort: 80, transport: "auto" } },
  template: {
    containers: [{ name: "web", image: "traefik/whoami:v1.10", resources: { cpu: 0.25, memory: "0.5Gi" } }],
    scale: { minReplicas: 1, maxReplicas: 1 },
  },
});

// The dns member reads this as its `azureEndpoint` parameter.
export const azureEndpoint = output(app.configuration_ingress_fqdn, "azureEndpoint");
