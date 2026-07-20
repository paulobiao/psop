# dynamodb.tf
# DynamoDB tables that store camera data.
# Two tables, by design:
#   1. camera_status  -> the LATEST state of each camera (overwritten on every heartbeat)
#   2. camera_events  -> a HISTORY log of important changes (online/offline, anomalies)

# ---------------------------------------------------------------------------
# Table 1: Current status of each camera (one row per camera, always up to date)
# ---------------------------------------------------------------------------
resource "aws_dynamodb_table" "camera_status" {
  name         = "${var.project_name}-status"
  billing_mode = "PAY_PER_REQUEST" # on-demand: pay only for what you use, no idle cost

  hash_key = "camera_id" # primary key: each camera has one unique row

  attribute {
    name = "camera_id"
    type = "S" # S = String
  }

  tags = {
    Name = "${var.project_name}-status"
  }
}

# ---------------------------------------------------------------------------
# Table 2: Event history (status changes over time, for the event feed + audit trail)
# ---------------------------------------------------------------------------
resource "aws_dynamodb_table" "camera_events" {
  name         = "${var.project_name}-events"
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "camera_id" # partition key: group events by camera
  range_key = "timestamp" # sort key: order events by time within each camera

  attribute {
    name = "camera_id"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "N" # N = Number (epoch time)
  }

  # Automatically delete events older than the TTL date stored in "expires_at".
  # Free, automatic data lifecycle — no cleanup job needed.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  tags = {
    Name = "${var.project_name}-events"
  }
}