# The long tail. `random_pet` is not an AWS resource at all, so there is nothing
# for it to map to and the advisor scores it 0 without inventing a story. Half
# the estate's names hang off it, which is the honest punchline of the demo:
# some Terraform stays Terraform indefinitely, and a migration that cannot say
# that out loud is selling something.

resource "random_pet" "suffix" {
  length    = 2
  separator = "-"
}
