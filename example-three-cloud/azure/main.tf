# The azure member as a choudoufu estate on floci-az (INTENTIUS/choudoufu#2246).
# The live block makes this a choudoufu root: ownership is the tofu-estate
# tag on each resource, and the subnet, which takes no tags, is held by its
# record in the local record store (.tofu-records beside this file).
#
# The provider block is written the way choudoufu's own floci-az estates
# write theirs (choudoufu live/e2e/lib/floci-az.sh, floci_az_azurerm_args):
# every endpoint and credential argument stated, so nothing in the shell can
# aim azurerm at a real subscription. metadata_host alone picks the cloud,
# and it can only be a loopback host:port. floci-az never checks the client
# secret; the value says it is a fake one, which is also what lets chant's
# TF008 (no literal credential in a provider block) tell it from a real one.
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "= 5.10.0"
    }
  }
  live {
    estate = "three-cloud-azure"
  }
}

variable "floci_az_host" {
  type        = string
  default     = "localhost:4577"
  description = "The floci-az container's host:port. scripts/front-door.ts sets TF_VAR_floci_az_host from AZURE_ENDPOINT_URL; never a real Azure host."
  validation {
    condition     = can(regex("^(localhost|127\\.0\\.0\\.1):[0-9]+$", var.floci_az_host))
    error_message = "floci_az_host must be a loopback host:port: this estate talks only to floci-az."
  }
}

provider "azurerm" {
  features {}
  subscription_id                 = "00000000-0000-0000-0000-000000000001"
  tenant_id                       = "00000000-0000-0000-0000-000000000002"
  client_id                       = "00000000-0000-0000-0000-000000000003"
  client_secret                   = "floci-az-fake-secret"
  metadata_host                   = var.floci_az_host
  use_cli                         = false
  use_msi                         = false
  use_oidc                        = false
  use_aks_workload_identity       = false
  resource_provider_registrations = "none"
  disable_terraform_partner_id    = true
}
