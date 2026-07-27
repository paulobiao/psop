# Automated Security Integration Testing

## Scope

This milestone converts PSOP's manually validated authentication and tenant-security scenarios into permanent end-to-end tests backed by an isolated PostgreSQL database.

## Automated controls

The suite validates:

- application startup and health;
- mandatory replacement of temporary passwords;
- absence of a session before password replacement;
- rejection of temporary-password reuse;
- single-use password-change challenges;
- refresh-token rotation;
- refresh-token replay detection and session revocation;
- role-based access control;
- organization isolation for users, sites and sessions;
- TOTP setup and authentication;
- rejection of invalid TOTP values;
- single-use MFA challenges;
- one-time recovery-code consumption;
- rejection of consumed recovery-code reuse;
- organization-scoped audit visibility;
- audit redaction of passwords and sensitive fields.

## Local database isolation

Local integration tests use a dedicated PostgreSQL database named `psop_test` inside the existing PSOP PostgreSQL container.

The normal development database named `psop` is not reset, dropped or modified by the integration-test script.

## Continuous integration

GitHub Actions starts a disposable PostgreSQL 16 service container for each workflow run.

The workflow:

1. installs locked dependencies;
2. validates the Prisma schema;
3. applies all migrations to the disposable test database;
4. executes permanent unit tests;
5. executes security integration tests;
6. builds the NestJS API;
7. type-checks and builds the dashboard.

## Infrastructure safety

The integration suite disables the automatic connectivity monitor and performs no AWS modifications.

No production database, cloud table or deployed environment is contacted.
