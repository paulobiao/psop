output "vpc_id" {
  value = aws_vpc.psop.id
}

output "api_ecr_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "database_endpoint" {
  value = aws_db_instance.psop.address
}

output "database_master_secret_arn" {
  value = aws_db_instance.psop.master_user_secret[0].secret_arn
}

output "dashboard_bucket" {
  value = aws_s3_bucket.dashboard.id
}

output "dashboard_url" {
  value = "https://${aws_cloudfront_distribution.dashboard.domain_name}"
}

output "api_service_enabled" {
  value = var.create_api_service
}

output "api_service_endpoint" {
  value = try(
    aws_ecs_express_gateway_service.api[0].ingress_paths[0].endpoint,
    null,
  )
}
