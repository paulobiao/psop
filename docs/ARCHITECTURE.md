# PSOP Architecture

## Overview

PSOP stands for Physical Security Observability Platform.

The platform monitors the operational health of physical security systems, beginning with IP camera fleets.

## Initial MVP

The first functional module is Camera Fleet Monitor.

It will register sites and devices, receive heartbeats, detect failures, generate alerts, expose data through an API, and display fleet health in a dashboard.

## Repository Structure

```text
apps/
  api/          NestJS REST API
  dashboard/    Web dashboard
  simulator/    Python camera fleet simulator

packages/
  shared/       Shared types and utilities
  config/       Shared project configuration

infra/
  terraform/    AWS infrastructure
  docker/       Local development containers
  aws/          Supporting AWS resources and scripts

docs/           Architecture and product documentation
scripts/        Development and automation scripts
```

## Core Domains

- Organization: company or customer using the platform.
- Site: physical location containing security devices.
- Device: monitored camera, recorder, gateway, sensor, access controller, intercom, or network device.
- Telemetry: health data periodically sent by devices.
- Device State: most recent known operational state.
- Event: important historical state change or anomaly.
- Alert: operational condition requiring attention.
- Assessment: inspection or health evaluation.
- User and Authentication: users, roles, permissions, and access control.

## Data Flow

```text
Camera Simulator
      |
      | MQTT over TLS
      v
AWS IoT Core
      |
      | IoT Topic Rule
      v
DynamoDB
  - current device state
  - operational event history
      |
      v
NestJS API
      |
      v
Dashboard
```

## Storage Strategy

### PostgreSQL

Stores organizations, users, sites, devices, alerts, assessments, maintenance records, and permissions.

### DynamoDB

Stores the latest device state and operational event history.

This separation keeps high-frequency telemetry out of the relational database.

## Security Principles

- Unique identity for every device.
- X.509 certificates for MQTT authentication.
- Least-privilege IoT policies.
- Least-privilege IAM roles.
- No credentials committed to Git.
- Environment-based configuration.
- Private databases.
- Auditable state transitions.
- Tenant isolation.
- Secure defaults.

## Initial API Endpoints

- GET /api/v1/health
- GET /api/v1/sites
- POST /api/v1/sites
- GET /api/v1/devices
- POST /api/v1/devices
- GET /api/v1/devices/:id
- GET /api/v1/devices/:id/status
- GET /api/v1/devices/:id/events
- GET /api/v1/alerts
- GET /api/v1/assessments

## Development Principles

- Modular monolith before microservices.
- Explicit domain boundaries.
- Infrastructure as code.
- Automated validation.
- Backward-compatible APIs.
- Avoid premature complexity.
- Design for future extraction of independent services.

## Current Status

Completed:

- Monorepo foundation.
- NestJS API.
- Health endpoint.
- Initial Site module.
- Python camera simulator.
- Fleet simulator.
- AWS IoT provisioning script.
- AWS IoT Core Terraform.
- DynamoDB Terraform.
- Environment-based configuration.
- GitHub repository and pull request workflow.

Next:

- Define the complete domain model.
- Add PostgreSQL with Docker.
- Configure Prisma.
- Implement persistent Site CRUD.
- Design Device and Telemetry modules.
