# PSOP Deployment Baseline

## Purpose

This milestone establishes a reproducible cloud deployment baseline for
the Physical Security Observability Platform.

The deployment architecture must preserve PSOP security, tenant isolation,
telemetry semantics, incident evidence and manual-only local gateway policy.

## Architecture

### Dashboard

Browser
  -> CloudFront HTTPS
  -> private S3 origin using Origin Access Control

The dashboard bucket is not public.

### API

PSOP API source
  -> Docker/OCI image
  -> Amazon ECR
  -> Amazon ECS Express Mode
  -> Fargate
  -> managed HTTPS endpoint / Application Load Balancer

The container listens on port 3100.

AWS App Runner is intentionally not used because AWS closed App Runner to
new customers and recommends ECS Express Mode as its successor.

### Database

Amazon RDS for PostgreSQL is the authoritative transactional database.

The database is deployed without public Internet accessibility.

ECS reaches RDS through VPC networking and a security-group boundary.

### Network model

The pilot baseline uses:

- one VPC;
- two public application subnets across Availability Zones;
- two private database subnets;
- Internet Gateway for application egress;
- no public RDS endpoint;
- security-group restricted PostgreSQL access.

The ECS task can retain outbound Internet capability for functionality that
may later require external services such as SMTP.

### Secrets

Secrets must never be committed or embedded in images/frontend bundles.

AWS Secrets Manager is the runtime secret source for:

- JWT access secret;
- JWT refresh secret;
- MFA encryption key;
- database password.

RDS manages its master password in Secrets Manager.

### Dashboard/API origin boundary

The dashboard and API may use different HTTPS origins.

The API therefore accepts a production `CORS_ORIGINS` configuration.

No permissive wildcard CORS is part of the production baseline.

### Existing IoT infrastructure

Existing AWS IoT Core and DynamoDB resources remain untouched.

They are a separate infrastructure responsibility and are not migrated into
the new deployment Terraform state.

PostgreSQL remains authoritative for application state unless a future
architecture decision explicitly changes that boundary.

### Observability

ECS application logs are sent to CloudWatch Logs.

The API health endpoint is:

`/api/v1/health`

### Terraform state

Terraform state must not be committed to Git.

The deployment stack is isolated under:

`infra/terraform/deployment`

The target backend is encrypted, versioned Amazon S3 state with Terraform
lockfile support.

### CI/CD authentication

GitHub Actions deployment will use GitHub OIDC -> AWS IAM role federation.

Long-lived AWS access keys are not the intended deployment authentication
model.

### Deployment safety

Infrastructure is created in phases:

1. validate Terraform locally;
2. inspect AWS account and existing resources;
3. create remote state backend;
4. generate and review Terraform plan;
5. estimate ongoing AWS cost;
6. provision foundation;
7. push API image;
8. populate required secrets;
9. apply database migrations;
10. enable API service;
11. publish dashboard;
12. collect deployment evidence.

No `terraform apply` is automatic during this milestone.

### Gateway boundary

The local PSOP gateway remains manual-only.

No launchd, launchctl or automatic background service is introduced.
