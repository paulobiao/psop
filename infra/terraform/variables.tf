# variables.tf
# Input variables — configurable values used across the whole stack.
# Defining them in one place avoids repetition and makes the project easy to reconfigure.

variable "aws_region" {
  description = "AWS region where all resources will be created"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name, used as a prefix for resource names and tags"
  type        = string
  default     = "camera-fleet-monitor"
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
  default     = "dev"
}