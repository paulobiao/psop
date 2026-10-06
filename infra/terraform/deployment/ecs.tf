resource "aws_ecs_cluster" "psop" {
  name = "${local.name_prefix}-cluster"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/psop/${var.environment}/api"
  retention_in_days = 30
}

resource "aws_ecs_express_gateway_service" "api" {
  count = var.create_api_service ? 1 : 0

  service_name            = "${local.name_prefix}-api"
  cluster                 = aws_ecs_cluster.psop.name
  execution_role_arn      = aws_iam_role.ecs_task_execution.arn
  infrastructure_role_arn = aws_iam_role.ecs_infrastructure.arn

  cpu                   = var.api_cpu
  memory                = var.api_memory
  health_check_path     = "/api/v1/health"
  wait_for_steady_state = true

  primary_container {
    image          = "${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
    container_port = var.api_container_port

    aws_logs_configuration {
      log_group         = aws_cloudwatch_log_group.api.name
      log_stream_prefix = "api"
    }

    environment {
      name  = "NODE_ENV"
      value = "production"
    }

    environment {
      name  = "PORT"
      value = tostring(var.api_container_port)
    }

    environment {
      name  = "DB_HOST"
      value = aws_db_instance.psop.address
    }

    environment {
      name  = "DB_PORT"
      value = tostring(aws_db_instance.psop.port)
    }

    environment {
      name  = "DB_NAME"
      value = var.db_name
    }

    environment {
      name  = "DB_USER"
      value = var.db_username
    }

    environment {
      name  = "CORS_ORIGINS"
      value = "https://${aws_cloudfront_distribution.dashboard.domain_name}"
    }

    environment {
      name  = "CONNECTIVITY_MONITOR_ENABLED"
      value = "true"
    }

    secret {
      name       = "DB_PASSWORD"
      value_from = "${aws_db_instance.psop.master_user_secret[0].secret_arn}:password::"
    }

    secret {
      name       = "JWT_SECRET"
      value_from = aws_secretsmanager_secret.jwt_access.arn
    }

    secret {
      name       = "JWT_REFRESH_SECRET"
      value_from = aws_secretsmanager_secret.jwt_refresh.arn
    }

    secret {
      name       = "MFA_ENCRYPTION_KEY"
      value_from = aws_secretsmanager_secret.mfa_encryption.arn
    }
  }

  network_configuration {
    subnets         = aws_subnet.public[*].id
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  scaling_target {
    min_task_count            = 1
    max_task_count            = 2
    auto_scaling_metric       = "AVERAGE_CPU"
    auto_scaling_target_value = 60
  }

  depends_on = [
    aws_iam_role_policy_attachment.ecs_task_execution,
    aws_iam_role_policy.ecs_secret_access,
    aws_iam_role_policy_attachment.ecs_infrastructure,
  ]
}
