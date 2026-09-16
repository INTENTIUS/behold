variable "name" {
  description = "Prefix for every resource this root names."
  type        = string
  default     = "waterline-prod"
}

variable "log_retention_days" {
  type    = number
  default = 30
}
