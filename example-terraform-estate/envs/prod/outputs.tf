output "vpc_id" {
  description = "The network everything in this environment sits in."
  value       = aws_vpc.main.id
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "service_role_arns" {
  description = "One per service module, for the platform root to reference back."
  value       = [module.checkout.role_arn, module.ledger.role_arn]
}
