# iot.tf
# AWS IoT Core: the managed MQTT broker that receives camera heartbeats,
# plus the rule that forwards each heartbeat into DynamoDB.

# ---------------------------------------------------------------------------
# 1. IoT Thing Type — a "template" describing what a camera is.
#    Real fleets group devices by type; this documents the device model.
# ---------------------------------------------------------------------------
resource "aws_iot_thing_type" "camera" {
  name = "${var.project_name}-camera"

  properties {
    description = "IP security camera that publishes heartbeats over MQTT/TLS"
  }
}

# ---------------------------------------------------------------------------
# 2. IAM Role — permission for the IoT Rule to write into DynamoDB.
#    Least privilege: this role can ONLY write to our two tables, nothing else.
# ---------------------------------------------------------------------------
resource "aws_iam_role" "iot_to_dynamodb" {
  name = "${var.project_name}-iot-dynamodb-role"

  # Who is allowed to "assume" (use) this role: the IoT service.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "iot.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

# The actual permissions attached to that role.
resource "aws_iam_role_policy" "iot_to_dynamodb" {
  name = "${var.project_name}-iot-dynamodb-policy"
  role = aws_iam_role.iot_to_dynamodb.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem"
        ]
        # Scoped to ONLY our two tables — not "*". This is least-privilege security.
        Resource = [
          aws_dynamodb_table.camera_status.arn,
          aws_dynamodb_table.camera_events.arn
        ]
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# 3. IoT Topic Rule — listens for heartbeats and writes them to camera_status.
#    SQL-like syntax: "take every message on cameras/+/+/heartbeat and store it".
# ---------------------------------------------------------------------------
resource "aws_iot_topic_rule" "heartbeat_to_status" {
  name        = replace("${var.project_name}_heartbeat_to_status", "-", "_")
  description = "Forward camera heartbeats into the DynamoDB status table"
  enabled     = true

  # The "+" wildcards match any site_id and any camera_id.
  # Topic pattern: cameras/{site_id}/{camera_id}/heartbeat
  sql         = "SELECT * FROM 'cameras/+/+/heartbeat'"
  sql_version = "2016-03-23"

  dynamodbv2 {
    role_arn = aws_iam_role.iot_to_dynamodb.arn

    put_item {
      table_name = aws_dynamodb_table.camera_status.name
    }
  }
}