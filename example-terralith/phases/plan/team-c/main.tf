terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.59.0"
    }
  }
  live {
    estate = "team-c"
  }
}

provider "aws" {
  region = "us-east-1"
}

# ---- team-c ----
resource "aws_iam_role" "team_c" {
  name               = "terralith-team-c-role"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}

resource "aws_iam_role_policy" "team_c_inline" {
  name   = "terralith-team-c-inline"
  role   = aws_iam_role.team_c.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["logs:CreateLogStream"], Resource = "*" }] })
}

resource "aws_iam_policy" "team_c" {
  name   = "terralith-team-c-policy"
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["logs:PutLogEvents"], Resource = "*" }] })
}

resource "aws_iam_role_policy_attachment" "team_c" {
  role       = aws_iam_role.team_c.name
  policy_arn = aws_iam_policy.team_c.arn
}

resource "aws_cloudwatch_log_group" "team_c_0" {
  name              = "/terralith/team-c/svc-0"
  retention_in_days = data.terraform_estate_outputs.platform.values.log_retention_days
}

resource "aws_cloudwatch_log_group" "team_c_1" {
  name              = "/terralith/team-c/svc-1"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "team_c_2" {
  name              = "/terralith/team-c/svc-2"
  retention_in_days = 7
}

# ---- the platform's shared settings ----
data "terraform_estate_outputs" "platform" {
  estate = "terralith"
  names  = ["log_retention_days"]
}
