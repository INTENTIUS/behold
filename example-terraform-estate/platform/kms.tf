resource "aws_kms_key" "estate" {
  description             = "Estate-wide key: artifact encryption and log group encryption."
  deletion_window_in_days = 14
  enable_key_rotation     = true
}

resource "aws_kms_alias" "estate" {
  name          = "alias/${var.name}-estate"
  target_key_id = aws_kms_key.estate.key_id
}

resource "aws_cloudwatch_log_group" "audit" {
  name              = "/${var.name}/audit"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.estate.arn
}
