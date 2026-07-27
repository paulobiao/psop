# Continuous Integration

## Objective

The PSOP continuous-integration workflow validates every pull request targeting `main` and every push to `main`.

## Workflow checks

The workflow performs:

1. repository checkout;
2. installation of Node.js 22.23.1;
3. installation of pnpm 11.15.0;
4. dependency installation from the lockfile;
5. Prisma schema validation;
6. Prisma Client generation;
7. API Jest execution;
8. NestJS production build;
9. dashboard TypeScript validation;
10. dashboard Vite production build.

## Security characteristics

- workflow permissions are read-only;
- concurrent runs for the same branch are cancelled;
- dependencies use `pnpm-lock.yaml`;
- installation uses `--frozen-lockfile`;
- no production database is contacted;
- no AWS infrastructure is modified;
- no application secrets are placed in the workflow;
- a non-routable development database URL is used only for Prisma generation and validation.

## Current scope

This workflow validates source integrity, generated Prisma code, permanent security unit tests and production compilation.

The permanent test suite currently includes TOTP generation and verification, time-window tolerance, encryption integrity, tamper detection and recovery-code protection.

It does not deploy PSOP and does not execute destructive infrastructure actions.

## Future improvements

- PostgreSQL service container for automated integration tests;
- permanent MFA and session-management E2E suites;
- dependency vulnerability scanning;
- CodeQL analysis;
- software bill of materials;
- signed release artifacts;
- deployment workflow with protected environments.
