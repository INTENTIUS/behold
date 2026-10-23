# A root the plan read can be asked of with no cloud (#910). Built-in
# `terraform_data` only, so `init` downloads nothing, and a `local` backend, so
# no credentials. src/terraform-plan.acceptance.test.ts copies it to a temp
# directory, applies it at generation 1, then writes a terraform.tfvars at
# generation 2 with a new token, so the plan replaces one block, updates
# another (with a sensitive value nested in its map) and leaves a third
# unknown until apply.
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}

variable "generation" {
  type    = string
  default = "1"
}

# Sensitive, and given only on the command line and in terraform.tfvars, so
# the value is in no .tf file and the redaction test can look for it in
# every response.
variable "token" {
  type      = string
  sensitive = true
}

# Replaced: `triggers_replace` forces it.
resource "terraform_data" "replaced" {
  triggers_replace = var.generation
  input            = "stable"
}

# Updated in place, with a sensitive value nested in a map.
resource "terraform_data" "updated" {
  input = {
    name  = "app-${var.generation}"
    token = var.token
  }
}

# Reads the replaced block's new id, unknown until apply.
resource "terraform_data" "downstream" {
  input = terraform_data.replaced.id
}
