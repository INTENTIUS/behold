# Outputs are invisible to `chant carve advise` — it builds its graph from
# `resource` and `module` blocks only. Nothing here references the bucket, so
# the walkthrough's one-patch story stays true; if it did, the patch would be
# yours to write, not the bridge's.

output "api_function_name" {
  value = aws_lambda_function.api.function_name
}

output "vpc_id" {
  value = aws_vpc.main.id
}

output "private_subnet_ids" {
  value = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}
