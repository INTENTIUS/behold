terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.59.0"
    }
  }
  live {
    estate = "team-a"
  }
}

provider "aws" {
  region = "us-east-1"
}

# ---- team-a ----
resource "aws_iam_role" "team_a" {
  name               = "terralith-team-a-role"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}

resource "aws_iam_role_policy" "team_a_inline" {
  name   = "terralith-team-a-inline"
  role   = aws_iam_role.team_a.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["logs:CreateLogStream"], Resource = "*" }] })
}

resource "aws_iam_policy" "team_a" {
  name   = "terralith-team-a-policy"
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["logs:PutLogEvents"], Resource = "*" }] })
}

resource "aws_iam_role_policy_attachment" "team_a" {
  role       = aws_iam_role.team_a.name
  policy_arn = aws_iam_policy.team_a.arn
}

resource "aws_cloudwatch_log_group" "team_a_0" {
  name              = "/terralith/team-a/svc-0"
  retention_in_days = data.terraform_estate_outputs.platform.values.log_retention_days
}

resource "aws_cloudwatch_log_group" "team_a_1" {
  name              = "/terralith/team-a/svc-1"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "team_a_2" {
  name              = "/terralith/team-a/svc-2"
  retention_in_days = 7
}

# ---- the platform's shared settings ----
data "terraform_estate_outputs" "platform" {
  estate = "terralith"
  names  = ["log_retention_days"]
}
