module "checkout" {
  source = "../../modules/service"

  name            = "${var.name}-checkout"
  subnet_ids      = [aws_subnet.private_a.id]
  boundary_arn    = data.aws_iam_policy.boundary.arn
  log_kms_key_arn = data.aws_kms_key.estate.arn
}

module "ledger" {
  source = "../../modules/service"

  name            = "${var.name}-ledger"
  subnet_ids      = [aws_subnet.private_a.id]
  boundary_arn    = data.aws_iam_policy.boundary.arn
  log_kms_key_arn = data.aws_kms_key.estate.arn
}

data "aws_iam_policy" "boundary" {
  name = "${var.name}-boundary"
}
