# Incident Notifications and Escalation

PSOP can create idempotent email-delivery evidence for connectivity incident opening and recovery transitions.

## Policy

An organization administrator can configure:

- enabled / disabled notification policy
- minimum severity (`WARNING` or `CRITICAL`)
- recovery notifications
- active `ADMIN` recipients
- active `OPERATOR` recipients
- up to 20 explicit email recipients
- per-device notification cooldown
- incident-opening escalation delay

Role-based recipients are resolved only from active, non-deleted users in the same organization.

## SMTP transport

SMTP configuration is server-side only:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASSWORD`
- `SMTP_FROM`

The API and dashboard expose only transport readiness. They never return SMTP credentials.

If SMTP is not configured, PSOP records the delivery as `SKIPPED_NOT_CONFIGURED`. It does not claim an email was sent.

## Delivery states

- `PENDING`
- `SENT`
- `FAILED`
- `SKIPPED_NOT_CONFIGURED`
- `SKIPPED_COOLDOWN`
- `SKIPPED_POLICY`

Every incident transition / channel / recipient combination has a stable unique deduplication key. Repeated fleet evaluations therefore do not generate duplicate notification records or duplicate email sends for the same transition.

Failed SMTP sends are retried up to three attempts. The notification worker runs only inside the PSOP API process while that API process is running. It does not install or enable any operating-system background service.

Administrators can also manually process due deliveries or retry a failed / not-configured delivery from the dashboard.

## Incident resilience

Notification processing is secondary to incident state. Failure of the notification subsystem does not prevent PSOP from opening or resolving the underlying connectivity alert.

## Security boundary

Notification policies and delivery history are tenant-scoped. Policy and delivery administration endpoints require the `ADMIN` role.

SMTP secrets belong in server environment configuration and must not be placed in the dashboard, API payloads, repository, audit metadata, or gateway configuration.

## Gateway boundary

This feature does not change gateway execution. The PSOP edge gateway remains manual-only and is started only when an operator chooses to run it.
