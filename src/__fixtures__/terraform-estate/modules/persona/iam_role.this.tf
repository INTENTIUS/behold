resource "aws_iam_role" "this" {
  name                 = var.name
  permissions_boundary = var.boundary_arn
}
