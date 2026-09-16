data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

# The cross-root read, and what behold does with it.
#
# `platform` declares this key and its alias; this root reads it back by alias
# rather than by a reference Terraform could resolve, because the two roots are
# applied separately and neither is a module of the other. That is how a real
# multi-root estate is wired, and it is also why NO EDGE is drawn between them:
# both ends carry the same unresolved `${var.name}` interpolation, so a match
# would be a coincidence of variable naming rather than a stated relationship.
# behold measured that and refused it (INTENTIUS/behold#381). What you get
# instead is this card, saying exactly what it reads — which is a claim the
# estate actually makes.
data "aws_kms_key" "estate" {
  key_id = "alias/${var.name}-estate"
}
