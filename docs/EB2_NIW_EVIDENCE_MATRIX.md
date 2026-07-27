# PSOP EB-2 NIW Technical Evidence Matrix

## Purpose

This matrix organizes technical evidence supporting the proposed endeavor involving the Physical Security Observability Platform.

It is a project-management document and not a legal conclusion regarding eligibility or approval.

## Proposed endeavor

Develop and advance a secure, cloud-native platform for continuous observability, operational monitoring and resilience analysis of heterogeneous physical-security and cyber-physical devices.

The endeavor is broader than a camera dashboard. It is intended to support device-health visibility, telemetry normalization, event correlation, operational alerts, access control, auditability and future deployment across multiple organizations and device ecosystems.

## Evidence matrix

| Technical claim | Existing evidence | Current status | Next evidence to produce |
|---|---|---|---|
| The endeavor is technically defined | `ARCHITECTURE.md`, `DOMAIN_MODEL.md` and proposed-endeavor document | Available | Keep architecture diagrams versioned |
| The platform has a functioning backend | NestJS modules, PostgreSQL, Prisma and API endpoints | Available | Generate OpenAPI documentation |
| The platform is multi-tenant by design | Organization-scoped models, JWT claims and authorization checks | Available | Add automated tenant-isolation tests |
| Authentication uses role-based access control | ADMIN, OPERATOR and VIEWER roles | Available | Create role-permission matrix |
| Administrative activity is auditable | Organization-scoped audit log and dashboard | Available | Export sanitized sample audit records |
| Sessions are centrally managed | Refresh-token rotation, session revocation and replay protection | Available | Add automated session-security tests |
| Accounts support strong authentication | TOTP MFA, encrypted secrets and recovery codes | Available | Screenshots and permanent E2E tests |
| New accounts are protected at first access | Mandatory temporary-password replacement | Available | Add onboarding workflow diagram |
| The system monitors physical-security devices | Sites, devices, telemetry and connectivity events | Available | Expand real-device laboratory evidence |
| Operational alerts are generated | Alert models, active-alert endpoints and resolution workflow | Available | Document alert accuracy and response metrics |
| Camera telemetry can be simulated | Python camera simulator | Available | Produce repeatable simulation dataset |
| Cloud telemetry integration exists | AWS IoT Core and DynamoDB infrastructure | Partially available | Create non-destructive deployment evidence |
| The platform can support heterogeneous devices | Normalized device and telemetry domain model | Design supported | Demonstrate a second device type |
| The project follows secure engineering practices | Pull requests, security controls, audit redaction and CI | In progress | Add dependency and static security scanning |
| The project has measurable development progress | Commits, PRs, migrations and build outputs | Available | Maintain milestone and release log |
| The developer is positioned to advance the work | Source-code authorship and project history | Available | Link résumé experience to individual modules |
| The endeavor can create broader operational value | Reusable observability architecture | Requires supporting record | Develop pilot or laboratory case studies |
| The endeavor has national-scale relevance | Cyber-physical resilience and security-device reliability rationale | Requires external support | Preserve authoritative research and industry sources |
| The project can be evaluated objectively | Health, alert, availability and recovery metrics | Partially defined | Create benchmark and evaluation protocol |
| The system has a professional delivery process | Git, PR review and initial CI workflow | In progress | Add releases, changelog and deployment workflow |

## Recommended exhibit structure

### Exhibit A — Proposed endeavor

- final proposed-endeavor statement;
- technical executive summary;
- problem definition;
- national-importance analysis;
- implementation roadmap.

### Exhibit B — Architecture

- system architecture;
- domain model;
- data-flow diagram;
- authentication and authorization flow;
- telemetry ingestion flow;
- alert-generation flow.

### Exhibit C — Software implementation

- repository history;
- selected source-code extracts;
- database migrations;
- API endpoint inventory;
- dashboard screenshots.

### Exhibit D — Security engineering

- authentication architecture;
- session-management report;
- MFA validation report;
- audit-logging evidence;
- data-redaction evidence;
- CI validation results.

### Exhibit E — Operational validation

- simulator results;
- device-health timelines;
- connectivity events;
- alert examples;
- recovery-time measurements;
- real laboratory equipment evidence.

### Exhibit F — Developer qualifications

- résumé;
- education;
- cloud-computing specialization;
- certifications;
- publications;
- peer-review activity;
- project ownership evidence.

## Evidence-quality rules

Every factual project claim should be supported by at least one durable artifact.

Preferred artifacts include:

- merged pull requests;
- immutable commit identifiers;
- versioned technical documents;
- automated test reports;
- screenshots with dates and context;
- sanitized database records;
- reproducible commands;
- architecture diagrams;
- benchmark data;
- release notes.

Avoid relying only on narrative descriptions when source code, test output or system-generated records can prove the same fact more objectively.
