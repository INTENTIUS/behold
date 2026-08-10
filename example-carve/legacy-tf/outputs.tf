# Outputs are boundary edges now (chant#1638): `chant carve advise` reads
# `output` blocks and scores each one a survivor reads across the cut, at -4,
# `bridge: "tf-output-rewrite"`. `assets_bucket` is deliberate — a downstream
# consumer of this state reads the bucket name today, so the carve has to
# rewrite that output the same way it rewrites `cdn.tf`'s data source.

output "assets_bucket" {
  value = aws_s3_bucket.assets.bucket
}

output "api_function_name" {
  value = aws_lambda_function.api.function_name
}

output "vpc_id" {
  value = aws_vpc.main.id
}

output "private_subnet_ids" {
  value = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}
