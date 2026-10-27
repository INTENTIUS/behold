# The star of the walkthrough.
#
# One inbound edge: the API lambda reads the bucket name out of its environment.
# That single reference is the whole cut — one `data "aws_s3_bucket"` block in
# the surviving Terraform and the carve is bridged. The two sub-resources below
# share the bucket's name, so the advisor folds them into its carve set and
# inlines them rather than counting them as boundary work.

resource "aws_s3_bucket" "assets" {
  bucket = "acme-platform-assets-prod"

  tags = {
    Name    = "acme-platform-assets"
    Purpose = "static-assets"
  }
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket = aws_s3_bucket.assets.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
