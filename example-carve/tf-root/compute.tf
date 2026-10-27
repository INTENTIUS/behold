# The "next month" candidates.
#
# The lambda is a tier-2 map with five outbound references — the role, the
# bucket, both subnets and the security group. None of them block a carve
# (outbound edges become deferred deploy-time inputs, not immediate patches),
# but five of them is real work, so it lands in the middle band honestly.
#
# The role is the mirror image: one inbound edge, from the lambda. That is what
# an inbound edge costs, and it is why the role scores lower than the bucket
# despite being just as small.

resource "aws_iam_role" "api" {
  name = "acme-platform-api-${random_pet.suffix.id}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "sts:AssumeRole"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  managed_policy_arns = [
    "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
  ]

  tags = {
    Component = "api"
  }
}

resource "aws_lambda_function" "api" {
  function_name = "acme-platform-api"
  role          = aws_iam_role.api.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  filename      = "build/api.zip"
  memory_size   = 512
  timeout       = 15

  environment {
    variables = {
      # The one edge into the bucket, and the only patch the carve needs.
      ASSETS_BUCKET = aws_s3_bucket.assets.bucket
      LOG_LEVEL     = "info"
    }
  }

  vpc_config {
    subnet_ids         = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    security_group_ids = [aws_security_group.lambda.id]
  }

  tags = {
    Component = "api"
  }
}
