terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.59.0"
    }
  }
  backend "s3" {
    bucket       = "terralith-state"
    key          = "terralith/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
  }
}

provider "aws" {
  region = "us-east-1"
}

# ---- network ----
resource "aws_vpc" "main" {
  cidr_block = "10.42.0.0/16"
  tags       = { Name = "terralith-main" }
}

resource "aws_subnet" "app" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.42.1.0/24"
  tags       = { Name = "terralith-app" }
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
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "team_a_1" {
  name              = "/terralith/team-a/svc-1"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "team_a_2" {
  name              = "/terralith/team-a/svc-2"
  retention_in_days = 7
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
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "team_b_1" {
  name              = "/terralith/team-b/svc-1"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "team_b_2" {
  name              = "/terralith/team-b/svc-2"
  retention_in_days = 7
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
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "team_c_1" {
  name              = "/terralith/team-c/svc-1"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "team_c_2" {
  name              = "/terralith/team-c/svc-2"
  retention_in_days = 7
}
