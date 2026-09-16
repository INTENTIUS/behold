variable "name" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "boundary_arn" {
  description = "The platform root's permissions boundary."
  type        = string
}

variable "log_kms_key_arn" {
  type = string
}
