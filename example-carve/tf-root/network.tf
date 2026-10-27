# The grey anchor.
#
# Five surviving resources point at the VPC, so carving it would mean patching
# five references in one go — the advisor bands it "leave in Terraform" and it
# is right. The subnets and the security group sit just under the line for the
# same reason, plus a data-source lookup each. This block stays in Terraform,
# and that is the correct answer, not a failure of the tool.

resource "aws_vpc" "main" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "acme-platform-${random_pet.suffix.id}"
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.42.1.0/24"
  availability_zone = data.aws_availability_zones.available.names[0]

  tags = {
    Name = "acme-platform-private-a-${random_pet.suffix.id}"
    Tier = "private"
  }
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.42.2.0/24"
  availability_zone = data.aws_availability_zones.available.names[1]

  tags = {
    Name = "acme-platform-private-b-${random_pet.suffix.id}"
    Tier = "private"
  }
}

# The managed prefix list for S3 in this region — how the lambda reaches the
# assets bucket without leaving the VPC.
data "aws_prefix_list" "s3" {
  name = "com.amazonaws.us-east-2.s3"
}

resource "aws_security_group" "lambda" {
  name        = "acme-platform-lambda-${random_pet.suffix.id}"
  description = "Egress-only group for the acme-platform API lambda"
  vpc_id      = aws_vpc.main.id

  egress {
    description     = "S3 via the regional gateway prefix list"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    prefix_list_ids = [data.aws_prefix_list.s3.id]
  }

  egress {
    description = "SSM interface endpoint, inside the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["10.42.0.0/16"]
  }

  tags = {
    Name = "acme-platform-lambda"
  }
}

# The API lambda reads /acme/platform/prod/* out of Parameter Store over this
# endpoint rather than the public SSM API.
resource "aws_vpc_endpoint" "ssm" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.us-east-2.ssm"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  security_group_ids  = [aws_security_group.lambda.id]
  private_dns_enabled = true

  tags = {
    Name = "acme-platform-ssm"
  }
}

# No native mapping at all — the advisor scores it 0 and says so rather than
# guessing. The second half of the long tail, next to random_pet below.
resource "aws_network_acl" "private" {
  vpc_id     = aws_vpc.main.id
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]

  ingress {
    protocol   = "tcp"
    rule_no    = 100
    action     = "allow"
    cidr_block = "10.42.0.0/16"
    from_port  = 0
    to_port    = 65535
  }

  egress {
    protocol   = "-1"
    rule_no    = 100
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 0
  }

  tags = {
    Name = "acme-platform-private"
  }
}
