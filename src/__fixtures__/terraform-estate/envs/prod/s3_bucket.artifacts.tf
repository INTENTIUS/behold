resource "aws_s3_bucket" "artifacts" {
  bucket = "${var.name}-artifacts"
}

module "desk_operator" {
  source = "../../modules/persona"

  name = "desk-operator"
}
