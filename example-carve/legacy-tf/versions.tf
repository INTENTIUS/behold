# The Terraform half of behold's carve demo estate (#254).
#
# Everything in this directory is still Terraform-owned. The chant half lives in
# ../app — the log group and the SSM parameter that came out of here last month.
#
# Nothing here has ever been applied to a real AWS account. The committed
# terraform.tfstate is synthetic (see its `_fixture_note` output and README.md),
# the account id in it is 000000000000, and every ARN is fake. Values are
# boring-realistic on purpose: the walkthrough video pauses on the inspect pane.
#
# `chant carve advise` parses these files with @cdktf/hcl2json — no terraform
# binary, no provider download, no network. See ../README.md for the scores this
# estate is tuned to produce and why each one lands where it does.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = "us-east-2"

  default_tags {
    tags = {
      Environment = "prod"
      ManagedBy   = "terraform"
      Team        = "platform"
    }
  }
}
