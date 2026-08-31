# Operational Health Engine V2 — Connectivity vs Health vs Collection Quality

PSOP historically answered three different operational questions with a single
`connectivity.state` value (`ONLINE | DEGRADED | OFFLINE | NEVER_SEEN |
UNKNOWN`). That conflated *reachability*, *equipment health*, and *how well the
adapter could read the equipment*. V2 separates them into three independent
dimensions.

## The three dimensions

### 1. Connectivity (link)

> "Is the device reachable / being observed inside its expected window?"

| State | Meaning |
|---|---|
| `ONLINE` | Fresh telemetry / observation inside the window. |
| `OFFLINE` | Heartbeat overdue, or a recorder authoritatively reports the channel offline. |
| `UNKNOWN` | Telemetry exists but is stale (recorder observation) or has an invalid timestamp. |
| `NEVER_SEEN` | No telemetry has ever been received. |

There is **no `DEGRADED`** in this dimension. It is exposed as
`connectivity.linkState`.

### 2. Health

> "Is the equipment operationally healthy?"

| State | Meaning |
|---|---|
| `HEALTHY` | No operational problem detected. |
| `DEGRADED` | A real, evidence-backed problem: `HIGH_TEMPERATURE`, `HIGH_STORAGE_USAGE`, `DEVICE_REPORTED_WARNING`, `RECORDING_ABNORMAL` (only when storage is physically present). |
| `CRITICAL` | e.g. a recorder-verified child channel is offline (`CAMERA_CHANNEL_OFFLINE`). |
| `UNKNOWN` | Cannot be assessed (link not ONLINE, or an unrecognised reported status). |

Health reasons are **never invented**. Codes such as `POE_POWER_ANOMALY` are
reserved for the day we have a tested threshold; they are not emitted yet.

### 3. Collection quality

> "Did the observation/adapter manage to collect every expected capability?"

| State | Meaning |
|---|---|
| `COMPLETE` | Every expected source responded **and `issues[]` is empty**. |
| `PARTIAL` | A source failed but the equipment was still confirmed (`COLLECTION_SOURCE_FAILED`) or an optional enrichment was unavailable (`OPTIONAL_ENRICHMENT_UNAVAILABLE`). |
| `FAILED` | The whole collection failed. |
| `NOT_APPLICABLE` | No adapter collection involved (plain camera, demo mode). |

**Invariant:** `COMPLETE` and a non-empty `issues[]` are mutually exclusive. Any
`OPTIONAL_ENRICHMENT_UNAVAILABLE` / `COLLECTION_SOURCE_FAILED` issue ⇒ at least
`PARTIAL`. `DeviceHealthService.evaluateCollection` enforces this: if an adapter
reports `COMPLETE` while still emitting an issue, the engine reconciles the state
down to `PARTIAL`. An optional gap is **never** escalated to `FAILED` — that is
reserved for a total core-collection failure.

**Collection quality never changes connectivity or health and never opens an
incident.** It is diagnostics/observability only (`overview.summary.collectionIssues`).

## Reason codes

Reasons are structured objects, not loose strings:

```jsonc
{ "code": "RECORDER_VERIFIED_OFFLINE", "source": "RECORDER",
  "observerDeviceId": "…", "channelNumber": 1 }
```

`source ∈ DEVICE | RECORDER | GATEWAY | ADAPTER | API`. Preserved codes:
`NO_TELEMETRY`, `INVALID_TIMESTAMP`, `HEARTBEAT_OVERDUE`, `STALE_OBSERVATION`,
`REPORTED_OFFLINE`, `RECORDER_VERIFIED_OFFLINE`, `HIGH_TEMPERATURE`,
`HIGH_STORAGE_USAGE`. Renamed: `REPORTED_STATUS_NOT_HEALTHY` →
`DEVICE_REPORTED_WARNING`. Added: `COLLECTION_SOURCE_FAILED`,
`OPTIONAL_ENRICHMENT_UNAVAILABLE`.

## Device operational snapshot

`GET /devices/:id/telemetry` (and the fleet / overview entries) now return:

```jsonc
{
  "connectivity": {
    "state": "ONLINE",          // compatibility alias (see below)
    "linkState": "ONLINE",      // the real connectivity dimension
    "reasons": ["…"],           // flat string list (legacy projection)
    "reasonRefs": [ { "code": "…", "source": "…" } ],
    "lastObservedAt": "…", "ageSeconds": 4, "offlineAfterSeconds": 120
  },
  "health":      { "state": "HEALTHY", "reasons": [] },
  "collection":  { "state": "COMPLETE", "issues": [] },
  "capabilities": {
    "storage":   { "supported": true, "present": false, "state": "NOT_INSTALLED" },
    "recording": { "state": "NOT_AVAILABLE_NO_STORAGE" }
  }
}
```

## Backward compatibility (temporary)

The frozen dashboard reads `connectivity.state` directly and expects it to carry
`DEGRADED`. Until the dashboard migrates, `connectivity.state` is a **compat
alias**:

```
connectivity.state =
  linkState !== 'ONLINE'                       -> linkState
  : health === 'UNKNOWN'                       -> 'UNKNOWN'
  : health === 'DEGRADED' || 'CRITICAL'        -> 'DEGRADED'
  : 'ONLINE'
```

`summary.degraded` is likewise computed from this alias (i.e. counts health
DEGRADED/CRITICAL). The incident pipeline (events, alerts, dedup, analytics,
notifications) still keys off the alias, so incident behaviour is unchanged; the
incident `context` now also carries `dimension` (`CONNECTIVITY` | `HEALTH`),
`linkState`, `healthState`, `collectionState`.

**To remove the alias later:** the dashboard switches to `connectivity.linkState`
+ `health.state` + `collection.state`; then `buildResponse` drops `state` (keep
`linkState`), and `evaluateFleet` keys off `linkState` / a derived incident state
instead of the alias.

## Real-lab examples

### (a) Speco NVR without HDD

```
authentication OK · queryOnlineChlList OK · 3 cameras online · no disk installed
```
- `connectivity.linkState = ONLINE`, `connectivity.state = ONLINE`
- `health = HEALTHY` — no HDD is a capability/configuration state, not a fault
- `collection = COMPLETE` only when every source responded; `PARTIAL` whenever
  an optional per-channel enrichment (`queryIPChlInfo`) is unavailable — which is
  the live-lab case today
- `capabilities.storage = { present: false, state: NOT_INSTALLED }`
- `capabilities.recording.state = NOT_AVAILABLE_NO_STORAGE`
- **no incident, no alert**

### (b) Hikvision 01 offline via the recorder

```
NVR ONLINE · queryOnlineChlList no longer lists channel 1
```
- child: `linkState = OFFLINE`, `health = CRITICAL`,
  reasons `REPORTED_OFFLINE` + `RECORDER_VERIFIED_OFFLINE`
- CRITICAL connectivity incident opens immediately (recorder is authoritative —
  never debounced)
- NVR, Hikvision 02/03 stay `ONLINE` / `HEALTHY`
- reconnect → child `ONLINE`, incident auto-resolves

### (c) Firmware enrichment unavailable

```
queryIPChlInfo errorCode=536870962 for the optional detailed firmware
```
- `collection = PARTIAL`, issue `OPTIONAL_ENRICHMENT_UNAVAILABLE`
- `connectivity = ONLINE`, `health = HEALTHY`
- visible in `overview.summary.collectionIssues`; **no incident, no alert**

### (d) Direct device heartbeat overdue

```
edge gateway stopped POSTing telemetry; age > 2 × expectedHeartbeatInterval
```
- `linkState = OFFLINE`, reason `HEARTBEAT_OVERDUE`, `health = UNKNOWN`
- CRITICAL connectivity incident opens
- `CONNECTIVITY_FLAP_MIN_CONSECUTIVE` (default `1` = off) can require N
  consecutive OFFLINE evaluations first — deterministic, no sleeps, and it
  never applies to recorder-verified OFFLINE.
