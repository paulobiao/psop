# outputs.tf
# Values Terraform prints after creating resources.
# We'll need these to configure the Python simulator (the IoT endpoint especially).

# The unique MQTT endpoint for YOUR AWS account.
# The simulator connects to this address to publish heartbeats.
output "iot_endpoint" {
  description = "AWS IoT Core MQTT endpoint for this account"
  value       = data.aws_iot_endpoint.current.endpoint_address
}

output "dynamodb_status_table" {
  description = "Name of the camera status table"
  value       = aws_dynamodb_table.camera_status.name
}

output "dynamodb_events_table" {
  description = "Name of the camera events table"
  value       = aws_dynamodb_table.camera_events.name
}

output "iot_thing_type" {
  description = "Name of the IoT thing type for cameras"
  value       = aws_iot_thing_type.camera.name
}

output "aws_region" {
  description = "AWS region where resources were created"
  value       = var.aws_region
}

# ---------------------------------------------------------------------------
# Data source: ask AWS for this account's unique IoT endpoint address.
# (Not a resource we create — it's information we read from AWS.)
# ---------------------------------------------------------------------------
data "aws_iot_endpoint" "current" {
  endpoint_type = "iot:Data-ATS"
}