provider "aws" {
  region = "us-east-1"
}

resource "aws_s3_bucket" "logs" {
  bucket = "logs"
}

module "vpc" {
  source = "../modules/vpc"
}
