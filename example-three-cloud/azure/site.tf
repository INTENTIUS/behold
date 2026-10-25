# The website on Azure Container Apps in West Europe: what the chant azure
# lexicon's ContainerAppNetwork and ContainerAppSite composites declared,
# resource for resource. The resource group is `local`, named after the
# environment, and the app is `web`, so scripts/front-door.ts finds the app
# at the same ARM path as before.

resource "azurerm_resource_group" "site" {
  name     = "local"
  location = "westeurope"
}

# The network: a VNet, and a subnet delegated to Container Apps environments.
resource "azurerm_virtual_network" "network" {
  name                = "three-cloud-vnet"
  location            = azurerm_resource_group.site.location
  resource_group_name = azurerm_resource_group.site.name
  address_space       = ["10.40.0.0/16"]
}

resource "azurerm_subnet" "apps" {
  name                 = "apps"
  resource_group_name  = azurerm_resource_group.site.name
  virtual_network_name = azurerm_virtual_network.network.name
  address_prefixes     = ["10.40.0.0/23"]

  delegation {
    name = "apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# The site: an environment in that subnet shipping logs to its own
# workspace, and one app running as a user-assigned identity.
resource "azurerm_log_analytics_workspace" "logs" {
  name                = "three-cloud-logs"
  location            = azurerm_resource_group.site.location
  resource_group_name = azurerm_resource_group.site.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_user_assigned_identity" "web" {
  name                = "three-cloud-web"
  location            = azurerm_resource_group.site.location
  resource_group_name = azurerm_resource_group.site.name
}

resource "azurerm_container_app_environment" "site" {
  name                       = "three-cloud"
  location                   = azurerm_resource_group.site.location
  resource_group_name        = azurerm_resource_group.site.name
  infrastructure_subnet_id   = azurerm_subnet.apps.id
  logs_destination           = "log-analytics"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.logs.id

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

resource "azurerm_container_app" "web" {
  name                         = "web"
  resource_group_name          = azurerm_resource_group.site.name
  container_app_environment_id = azurerm_container_app_environment.site.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.web.id]
  }

  ingress {
    external_enabled = true
    target_port      = 80
    transport        = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 1
    max_replicas = 1
    container {
      name   = "web"
      image  = "traefik/whoami:v1.10"
      cpu    = 0.25
      memory = "0.5Gi"
    }
  }
}

# The dns member reads this as its `azureEndpoint` parameter. The name is the
# one the chant member published, so the join stays the same; wiring a
# choudoufu output into a chant parameter is INTENTIUS/chant#4455 (C5).
output "azureEndpoint" {
  value = azurerm_container_app.web.ingress[0].fqdn
}
