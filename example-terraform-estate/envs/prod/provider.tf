provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Estate      = "waterline"
      Environment = "prod"
    }
  }
}
