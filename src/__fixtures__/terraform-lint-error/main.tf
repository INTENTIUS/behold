# #919: one root, one error-severity finding. The terraform lexicon's TF033
# flags a database stored unencrypted. behold must still draw it, and say so.
terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

resource "aws_db_instance" "orders" {
  identifier        = "orders"
  engine            = "postgres"
  instance_class    = "db.t3.micro"
  allocated_storage = 20
  storage_encrypted = false
}
