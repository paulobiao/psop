resource "aws_secretsmanager_secret" "jwt_access" {
  name                    = "${local.name_prefix}/jwt-access"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "jwt_refresh" {
  name                    = "${local.name_prefix}/jwt-refresh"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "mfa_encryption" {
  name                    = "${local.name_prefix}/mfa-encryption"
  recovery_window_in_days = 7
}
