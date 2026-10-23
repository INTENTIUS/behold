terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  default = "us-east-1"
}

variable "api_token" {
  type      = string
  default   = "tok-hunter2-string"
  sensitive = true
}

variable "db_port" {
  type      = number
  default   = 4815162342
  sensitive = true
}

variable "db_creds" {
  type      = map(string)
  sensitive = true
  default = {
    user = "admin-sekrit-user"
    pass = "pass-sekrit-map"
  }
}

resource "aws_sqs_queue" "jobs" {
  name = "jobs-${var.region}"
}
