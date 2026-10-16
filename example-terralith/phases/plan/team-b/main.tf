terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.59.0"
    }
  }
  live {
    estate = "team-b"
  }
}

provider "aws" {
  region = "us-east-1"
}

# ---- team-b ----
resource "aws_iam_role" "team_b" {
  name               = "terralith-team-b-role"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}

resource "aws_iam_role_policy" "team_b_inline" {
  name   = "terralith-team-b-inline"
  role   = aws_iam_role.team_b.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["logs:CreateLogStream"], Resource = "*" }] })
}

resource "aws_iam_policy" "team_b" {
  name   = "terralith-team-b-policy"
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["logs:PutLogEvents"], Resource = "*" }] })
}

resource "aws_iam_role_policy_attachment" "team_b" {
  role       = aws_iam_role.team_b.name
  policy_arn = aws_iam_policy.team_b.arn
}

resource "aws_cloudwatch_log_group" "team_b_0" {
  name              = "/terralith/team-b/svc-0"
  retention_in_days = data.terraform_estate_outputs.platform.values.log_retention_days
}

resource "aws_cloudwatch_log_group" "team_b_1" {
  name              = "/terralith/team-b/svc-1"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "team_b_2" {
  name              = "/terralith/team-b/svc-2"
  retention_in_days = 7
}

# ---- the platform's shared settings ----
data "terraform_estate_outputs" "platform" {
  estate = "terralith"
  names  = ["log_retention_days"]
}
