# PSOP Domain Model

## Purpose

This document defines the main entities, responsibilities, and relationships of the PSOP platform.

## Domain Hierarchy

```text
Organization
  └── Site
       └── Device
            ├── Device State
            ├── Telemetry
            ├── Event
            ├── Alert
            └── Assessment
```

## Organization

Represents a company, customer, or tenant using PSOP.

Key fields:

- id
- name
- slug
- status
- created_at
- updated_at

Relationships:

- has many users;
- has many sites;
- owns all business data within its tenant boundary.

## Site

Represents a physical location managed by an organization.

Key fields:

- id
- organization_id
- name
- code
- timezone
- address
- status
- created_at
- updated_at

Relationships:

- belongs to one organization;
- has many devices;
- has many alerts and assessments through its devices.

## Device

Represents a physical security device monitored by PSOP.

Key fields:

- id
- site_id
- name
- external_id
- device_type
- manufacturer
- model
- firmware_version
- ip_address
- serial_number
- status
- expected_heartbeat_interval
- created_at
- updated_at

Initial device types:

- camera
- recorder
- gateway
- access_controller
- sensor
- intercom
- network_switch

Relationships:

- belongs to one site;
- has one current device state;
- has many telemetry records;
- has many events;
- has many alerts;
- may have many assessments.

## Device State

Represents the most recent known operational condition of a device.

Key fields:

- device_id
- operational_status
- last_seen_at
- last_heartbeat_at
- temperature_c
- bitrate_kbps
- storage_used_pct
- uptime_seconds
- firmware_version
- updated_at

Initial operational statuses:

- online
- offline
- degraded
- warning
- unknown

Relationships:

- belongs to one device;
- is replaced whenever newer telemetry becomes the current state.

## Telemetry

Represents a time-series record of health data received from a device.

Key fields:

- device_id
- timestamp
- status
- temperature_c
- bitrate_kbps
- storage_used_pct
- uptime_seconds
- firmware_version
- raw_payload

Relationships:

- belongs to one device;
- may update the current device state;
- may generate events or alerts.

## Event

Represents an immutable historical record of an important operational change or anomaly.

Key fields:

- id
- device_id
- event_type
- severity
- source
- occurred_at
- payload
- created_at

Initial event types:

- device_online
- device_offline
- device_degraded
- high_temperature
- high_storage_usage
- firmware_changed
- heartbeat_missed

Relationships:

- belongs to one device;
- may trigger one or more alerts;
- is retained for operational history and audit.

## Alert

Represents an operational condition that requires attention.

Key fields:

- id
- organization_id
- site_id
- device_id
- event_id
- alert_type
- severity
- status
- message
- opened_at
- acknowledged_at
- resolved_at
- created_at
- updated_at

Initial alert statuses:

- open
- acknowledged
- resolved
- suppressed

Relationships:

- belongs to one organization;
- belongs to one site;
- may belong to one device;
- may be triggered by one event;
- may be acknowledged or resolved by a user.

## Assessment

Represents a structured inspection or health evaluation of a site or device.

Key fields:

- id
- organization_id
- site_id
- device_id
- assessment_type
- status
- score
- summary
- findings
- recommendations
- performed_by_user_id
- performed_at
- created_at
- updated_at

Initial assessment statuses:

- draft
- in_progress
- completed
- archived

Relationships:

- belongs to one organization;
- belongs to one site;
- may be linked to one device;
- is performed by a user;
- may generate alerts, findings, or maintenance recommendations.

## User and Organization Membership

Represents an authenticated person and their access to one or more organizations.

User key fields:

- id
- email
- display_name
- status
- created_at
- updated_at

Membership key fields:

- id
- organization_id
- user_id
- role
- status
- created_at
- updated_at

Initial roles:

- owner
- administrator
- operator
- technician
- viewer

Relationships:

- a user may belong to many organizations;
- an organization may have many users;
- membership defines the user's role within each organization;
- user actions on alerts and assessments are recorded for auditability.

## Cross-Domain Rules

- Every business record must be isolated by organization.
- A site cannot belong to more than one organization.
- A device cannot belong to more than one site.
- Device external identifiers must be unique within an organization.
- Device state must always refer to the most recent accepted telemetry.
- Events are immutable after creation.
- Alert status changes must be auditable.
- User access is determined by organization membership.
- All timestamps are stored in UTC.
- Soft deletion should be used for business entities when audit history must be preserved.

## Persistence Boundaries

### PostgreSQL

- Organization
- User
- Organization Membership
- Site
- Device
- Alert
- Assessment

### DynamoDB

- Device State
- Telemetry
- Event

PostgreSQL stores business and relational data. DynamoDB stores high-frequency operational data.
