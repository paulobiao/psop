variable "aws_region" {
  type        = string
  description = "AWS region for the PSOP deployment."
  default     = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "psop"
}

variable "environment" {
  type    = string
  default = "pilot"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "public_subnet_cidrs" {
  type = list(string)
  default = [
    "10.40.0.0/24",
    "10.40.1.0/24",
  ]
}

variable "database_subnet_cidrs" {
  type = list(string)
  default = [
    "10.40.10.0/24",
    "10.40.11.0/24",
  ]
}

variable "api_container_port" {
  type    = number
  default = 3100
}

variable "api_cpu" {
  type    = string
  default = "256"
}

variable "api_memory" {
  type    = string
  default = "512"
}

variable "api_image_tag" {
  type    = string
  default = "bootstrap"
}

variable "create_api_service" {
  type        = bool
  description = "Enable only after image, secrets and DB migration path are ready."
  default     = false
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_name" {
  type    = string
  default = "psop"
}

variable "db_username" {
  type    = string
  default = "psop_app"
}
