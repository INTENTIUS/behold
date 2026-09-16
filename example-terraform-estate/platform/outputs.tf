output "boundary_arn" {
  value = aws_iam_policy.boundary.arn
}

output "kms_key_arn" {
  value = aws_kms_key.estate.arn
}
