variable "region" {
  description = "The region every resource in this root is created in."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Prefix for every resource this root names."
  type        = string
  default     = "waterline-prod"
}

variable "vpc_cidr" {
  description = "The network this environment sits in."
  type        = string
  default     = "10.40.0.0/16"
}
