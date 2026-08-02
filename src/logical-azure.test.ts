import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { projectAzureLogical, resourceIdNames, subnetVnetName, AZURE_HEADLINE_KINDS } from "./logical-azure.ts";

const armId = (type: string, name: string) => `[resourceId('${type}', '${name}')]`;

const n = (id: string, kind: string, file: string, attrs: Record<string, unknown> = {}) => ({
  id,
  kind,
  lexicon: "azure",
  attrs,
  sourceLoc: { file },
});

/** Shaped like chant's real ARM IR (verified against `k8s-aks-microservice`):
 * a subnet names its VNet in `name`, and associations are ARM expression
 * strings rather than `$ref`s. */
function fixture(): GraphIR {
  const NET = "src/net/network.ts";
  const APP = "src/app/app.ts";
  return {
    nodes: [
      n("virtualNetwork", "Microsoft.Network/virtualNetworks", NET, {
        name: "app-vnet",
        addressSpace: { addressPrefixes: ["10.0.0.0/16"] },
      }),
      n("subnetWeb", "Microsoft.Network/virtualNetworks_subnets", NET, {
        name: "app-vnet/web",
        addressPrefix: "10.0.1.0/24",
        networkSecurityGroup: { id: armId("Microsoft.Network/networkSecurityGroups", "web-nsg") },
      }),
      n("subnetData", "Microsoft.Network/virtualNetworks_subnets", NET, {
        name: "app-vnet/data",
        addressPrefix: "10.0.2.0/24",
      }),
      n("nsg", "Microsoft.Network/networkSecurityGroups", NET, { name: "web-nsg", securityRules: [] }),
      n("identity", "Microsoft.ManagedIdentity/userAssignedIdentities", NET, { name: "shared-id" }),
      n("vm", "Microsoft.Compute/virtualMachines", APP, {
        name: "web-vm",
        subnet: { id: armId("Microsoft.Network/virtualNetworks_subnets", "app-vnet/web") },
        identity: { id: armId("Microsoft.ManagedIdentity/userAssignedIdentities", "shared-id") },
      }),
      n("db", "Microsoft.Sql/servers", APP, {
        name: "app-sql",
        subnet: { id: armId("Microsoft.Network/virtualNetworks_subnets", "app-vnet/data") },
        identity: { id: armId("Microsoft.ManagedIdentity/userAssignedIdentities", "shared-id") },
      }),
      n("registry", "Microsoft.ContainerRegistry/registries", APP, { name: "appacr" }),
    ],
    edges: [],
    groups: {},
  } as unknown as GraphIR;
}

const parentOf = (bc: Record<string, string[]>, id: string) =>
  Object.entries(bc).find(([, ids]) => ids.includes(id))?.[0];

describe("resourceIdNames", () => {
  it("pulls the resource name out of an ARM expression — the last quoted argument", () => {
    expect(resourceIdNames(armId("Microsoft.Network/networkSecurityGroups", "web-nsg"))).toEqual(["web-nsg"]);
  });

  it("handles a nested-name resourceId, where the name is the final argument", () => {
    expect(resourceIdNames("[resourceId('Microsoft.Network/virtualNetworks/subnets', 'vnet', 'web')]")).toEqual(["web"]);
  });

  it("ignores a plain string and a non-string", () => {
    expect(resourceIdNames("just-a-name")).toEqual([]);
    expect(resourceIdNames({ id: 1 })).toEqual([]);
    expect(resourceIdNames(undefined)).toEqual([]);
  });
});

describe("subnetVnetName", () => {
  it("reads the parent VNet from the subnet's own name", () => {
    expect(subnetVnetName({ attrs: { name: "app-vnet/web" } } as never)).toBe("app-vnet");
  });

  it("has no parent for an unqualified name", () => {
    expect(subnetVnetName({ attrs: { name: "web" } } as never)).toBeUndefined();
  });
});

describe("projectAzureLogical (#102)", () => {
  const { ir, byContainer } = projectAzureLogical(fixture(), "prod");

  it("keeps only headline resources — fabric and identity hubs are not cards", () => {
    expect(ir.nodes.map((x) => x.id).sort()).toEqual(["db", "registry", "vm"]);
  });

  it("nests resource group -> VNet -> subnet", () => {
    expect(parentOf(byContainer, "VNet 10.0.0.0/16")).toBe("resource group prod");
    expect(parentOf(byContainer, "subnet 10.0.1.0/24")).toBe("VNet 10.0.0.0/16");
    expect(parentOf(byContainer, "subnet 10.0.2.0/24")).toBe("VNet 10.0.0.0/16");
  });

  it("places a card in the subnet it references through an ARM expression", () => {
    // The association is a `[resourceId(...)]` string, not a `$ref` — the AWS
    // lens's collectRefs would see nothing here at all.
    expect(parentOf(byContainer, "vm")).toBe("app");
    expect(parentOf(byContainer, "app")).toBeDefined();
  });

  it("splits component boxes by the subnet their members share", () => {
    // vm is in web, db is in data, so the `app` component cannot sit in either
    // and falls to the resource group — the same rule the AWS lens uses.
    expect(parentOf(byContainer, "app")).toBe("resource group prod");
  });

  it("names the resource group from the environment, since ARM never declares it", () => {
    const { byContainer: noEnv } = projectAzureLogical(fixture());
    expect(Object.keys(noEnv)).toContain("resource group");
    expect(Object.keys(noEnv)).not.toContain("resource group prod");
  });

  it("draws no edge through a shared managed identity", () => {
    // vm and db both reference `shared-id`. Bridging through it would wire
    // every workload to every other — the hairball the fabric list prevents.
    expect(ir.edges.some((e) => (e.from === "vm" && e.to === "db") || (e.from === "db" && e.to === "vm"))).toBe(false);
  });

  it("carries the guarding NSG onto cards in a guarded subnet, and only those", () => {
    const single = projectAzureLogical(
      {
        nodes: [
          n("virtualNetwork", "Microsoft.Network/virtualNetworks", "src/net/n.ts", {
            name: "app-vnet",
            addressSpace: { addressPrefixes: ["10.0.0.0/16"] },
          }),
          n("subnetWeb", "Microsoft.Network/virtualNetworks_subnets", "src/net/n.ts", {
            name: "app-vnet/web",
            addressPrefix: "10.0.1.0/24",
            networkSecurityGroup: { id: armId("Microsoft.Network/networkSecurityGroups", "web-nsg") },
          }),
          n("nsg", "Microsoft.Network/networkSecurityGroups", "src/net/n.ts", { name: "web-nsg", securityRules: [] }),
          n("vm", "Microsoft.Compute/virtualMachines", "src/app/a.ts", {
            name: "web-vm",
            subnet: { id: armId("Microsoft.Network/virtualNetworks_subnets", "app-vnet/web") },
          }),
          n("registry", "Microsoft.ContainerRegistry/registries", "src/app/a.ts", { name: "appacr" }),
        ],
        edges: [],
        groups: {},
      } as unknown as GraphIR,
      "prod",
    );
    const vm = single.ir.nodes.find((x) => x.id === "vm")!;
    const registry = single.ir.nodes.find((x) => x.id === "registry")!;
    expect((vm.attrs as Record<string, unknown>)._nsg).toBe("web-nsg");
    // The registry is not in a guarded subnet, so it carries no NSG.
    expect((registry.attrs as Record<string, unknown>)._nsg).toBeUndefined();
  });

  it("leaves a non-azure graph alone", () => {
    const aws = { nodes: [{ id: "vpc", kind: "AWS::EC2::VPC", lexicon: "aws", attrs: {} }], edges: [], groups: {} } as unknown as GraphIR;
    const out = projectAzureLogical(aws, "prod");
    expect(out.ir.nodes).toHaveLength(0);
    expect(out.byContainer).toEqual({});
  });

  it("recognises the kinds #102 names as headline", () => {
    for (const kind of [
      "Microsoft.Compute/virtualMachines",
      "Microsoft.ContainerService/managedClusters",
      "Microsoft.Network/publicIPAddresses",
    ]) {
      expect(AZURE_HEADLINE_KINDS.has(kind)).toBe(true);
    }
    // Fabric is never a card, whatever #102's "Microsoft.Network/*" suggests.
    for (const kind of [
      "Microsoft.Network/virtualNetworks",
      "Microsoft.Network/virtualNetworks_subnets",
      "Microsoft.Network/networkSecurityGroups",
    ]) {
      expect(AZURE_HEADLINE_KINDS.has(kind)).toBe(false);
    }
  });
});
