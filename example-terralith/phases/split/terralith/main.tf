terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.59.0"
    }
  }
  live {
    estate = "terralith"
  }
}

provider "aws" {
  region = "us-east-1"
}

# ---- network ----
resource "aws_vpc" "main" {
  cidr_block = "10.42.0.0/16"
  tags       = { Name = "terralith-main" }
}

resource "aws_subnet" "app" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.42.1.0/24"
  tags       = { Name = "terralith-app" }
}
