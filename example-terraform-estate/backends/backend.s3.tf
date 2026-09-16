# A backend fragment, copied into a root when one is initialised. It declares
# a `terraform` block and nothing to draw, which is why discovery reports it as
# skipped rather than drawing an empty box for it.
terraform {
  backend "s3" {
    bucket = "waterline-tfstate"
    key    = "prod/terraform.tfstate"
    region = "us-east-1"
  }
}
