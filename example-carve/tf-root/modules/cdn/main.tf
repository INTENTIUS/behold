# A deliberately small local module, so `module.cdn` resolves without a registry
# download and `terraform init` works offline. The advisor never reads this file:
# `carve advise --from ../..` lists only the `.tf` files directly under the
# estate directory, which is the same scoping Terraform itself uses for a module.

variable "name_suffix" {
  type        = string
  description = "Shared random suffix, so the distribution comment matches the rest of the estate."
}

variable "origin_domain_name" {
  type        = string
  description = "Hostname the distribution pulls assets from."
}

variable "aliases" {
  type        = list(string)
  description = "Public hostnames the distribution answers on."
}

variable "price_class" {
  type    = string
  default = "PriceClass_100"
}

resource "aws_cloudfront_distribution" "this" {
  enabled     = true
  comment     = "acme-platform-assets-${var.name_suffix}"
  aliases     = var.aliases
  price_class = var.price_class

  origin {
    origin_id   = "assets"
    domain_name = var.origin_domain_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "assets"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false

      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

output "domain_name" {
  value = aws_cloudfront_distribution.this.domain_name
}
