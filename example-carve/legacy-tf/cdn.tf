# The one module in the estate, so module scoring shows up on camera. A module
# is opaque to the advisor: it is one node, ranked as a tier-2 composite, and
# its internals (modules/cdn/) are never descended into.
#
# The `aliases` line is the bridge patch left over from last month's carve. That
# hostname used to come from `aws_ssm_parameter.assets_cdn_domain` in this
# directory; chant owns the parameter now (../app/src/carved.ts), and the
# surviving Terraform reads it back through a data source. This is exactly the
# rewrite `carve bridge` generates for every inbound edge a carve cuts, sitting
# in the estate a month later and working.

data "aws_ssm_parameter" "assets_cdn_domain" {
  name = "/acme/platform/prod/assets-cdn-domain"
}

module "cdn" {
  source = "./modules/cdn"

  name_suffix        = random_pet.suffix.id
  origin_domain_name = "assets.acme-platform.example.com"
  aliases            = [data.aws_ssm_parameter.assets_cdn_domain.value]
  price_class        = "PriceClass_100"
}
