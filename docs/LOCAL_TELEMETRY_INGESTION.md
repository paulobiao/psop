# Local Telemetry Ingestion

PSOP can receive authenticated camera heartbeats directly through:

```text
POST /api/v1/telemetry/ingest
```

Enable it with:

```text
LOCAL_TELEMETRY_INGESTION_ENABLED=true
TELEMETRY_DEMO_MODE=false
```

Each camera has an independent high-entropy key. Rotate it with:

```text
POST /api/v1/devices/:id/ingestion-key/rotate
```

Only ADMIN and OPERATOR users can rotate keys. The raw key is returned once; PostgreSQL stores only its SHA-256 hash and a non-secret prefix.

Headers required by the ingestion endpoint:

```text
x-device-id: <camera UUID>
x-device-key: <device key>
```

PostgreSQL persists the latest telemetry snapshot, connectivity history and synchronized alerts. When this mode is enabled, PSOP bypasses DynamoDB for telemetry and connectivity events.

Use the VS Code tasks:

- `PSOP: Start Local Telemetry Ingestion`
- `PSOP: Local HTTP Simulator`

## Dashboard credential management

The camera details panel exposes credential status to authenticated users without returning the raw secret.

Administrators and operators can generate or rotate a camera key. Rotation immediately invalidates the previous key. The complete key is held only in React component state and disappears when the panel closes, the camera changes, the page refreshes or five minutes pass.

The dashboard also provides:

- a one-time Copy key action;
- a simulator command that prompts for the key securely;
- the non-secret key prefix;
- the most recent rotation timestamp;
- a disabled-state notice when local ingestion is not active.
