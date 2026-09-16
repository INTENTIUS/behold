# The permissions boundary every service role in the estate attaches. Declared
# once here; each environment root reads it back by name as a data source.
resource "aws_iam_policy" "boundary" {
  name        = "${var.name}-boundary"
  description = "Ceiling for every role the service module creates."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "logs:PutLogEvents", "sqs:*"]
        Resource = "*"
      },
      {
        Effect   = "Deny"
        Action   = ["iam:*", "organizations:*"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_iam_role" "deploy" {
  name = "${var.name}-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "deploy_boundary" {
  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.boundary.arn
}
