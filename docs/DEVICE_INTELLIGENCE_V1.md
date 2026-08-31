# Device Intelligence V1

> Consolidated, provenance-aware projection of everything PSOP actually knows
> about one device. Additive and read-only. Builds on
> [Operational Health Engine V2](./OPERATIONAL_HEALTH_ENGINE_V2.md) and never
> re-implements it.

## Purpose

PSOP stores what it knows about a device across many places: the inventory
(`Device`), the direct telemetry snapshot (`DeviceTelemetrySnapshot`, including
`details` / `capabilities` / `collectionState`), the recorder observation
snapshot (`RecorderObservationSnapshot`), the Health Engine V2 evaluation,
`monitoringMode` / `gatewayDeviceId`, and the Speco / generic-gateway adapters.

Device Intelligence answers, in one call, four questions per fact:

1. **What** is the value?
2. **Where** did it come from? (`source`)
3. **When** was it observed? (`observedAt` / `receivedAt` / `ageSeconds`)
4. **How much weight** does it carry? (`confidence` — a category, never a number)

It also states, explicitly, **what it does not know and does not infer**
(`limitations`).

### What Device Intelligence is NOT

- No health score, risk score, confidence percentage or "AI" ranking.
- No new evaluation logic — connectivity / health / collection come verbatim
  from `DeviceHealthService` via `DeviceTelemetryService.findByDeviceId`. In
  particular `collection.state` is whatever the Health Engine concluded: it is
  `PARTIAL` whenever `collection.issues[]` is non-empty (an
  `OPTIONAL_ENRICHMENT_UNAVAILABLE` gap included) and only `COMPLETE` when there
  are no issues — Device Intelligence never re-derives or "upgrades" it.
- No inference. A value that was not observed and is not declared stays `null`.

## Endpoint

```
GET /api/v1/devices/:deviceId/intelligence
```

- JWT-authenticated (global guard), any role.
- **Tenant isolation:** a device outside the caller's organization returns
  `404 Not Found` — identical to a non-existent device. Existence is never
  leaked. (Same policy as `GET /devices/:id` and `.../telemetry`.)
- Non-UUID `:deviceId` → `400`.
- Strictly read-only: it issues only `findUnique` / `findFirst` / `findMany`
  reads and calls `DeviceTelemetryService.findByDeviceId` (itself read-only).
  It never writes, and it never triggers `evaluateFleet`.

## Sources

| `source` | Meaning | Typical fields |
|---|---|---|
| `DEVICE` | The monitored equipment itself reported it (direct edge-agent telemetry on a `DIRECT` camera). | connectivity, model, firmware |
| `RECORDER` | A recorder/NVR reported it about one of its channels. | connectivity, model, firmware, PoE, recording, channel |
| `ADAPTER` | A protocol adapter collected it from the equipment (Speco N8NRL adapter reading the NVR). | model, firmware, `hardwareVersion`, `apiVersion`, `onvifVersion`, PoE budget, storage state |
| `GATEWAY` | An edge gateway derived it from reachability probes (`psop_gateway.py`, e.g. the Lorex Home Center). | connectivity, model (from gateway config) |
| `INVENTORY` | A human entered it when registering the device. | manufacturer, model, firmware, IP, serial |
| `API` | PSOP itself derived it (timestamps, counters). | — |

The source of a device's live data is decided **deterministically** from the
inventory model, never guessed:

| monitoringMode | deviceType | primary source |
|---|---|---|
| `VIA_GATEWAY` + recorder observation present | `CAMERA` | `RECORDER` |
| `VIA_GATEWAY` + no observation | `CAMERA` | none (inventory only) |
| `DIRECT` | `RECORDER` | `ADAPTER` |
| `DIRECT` | `GATEWAY` | `GATEWAY` |
| `DIRECT` | `CAMERA` | `DEVICE` |
| anything else / `INVENTORY_ONLY` | any | none (inventory only) |

## Confidence

A category, not a score:

| `confidence` | When |
|---|---|
| `VERIFIED` | A recorder authoritatively confirmed it for this channel (`individualVerification === 'RECORDER_VERIFIED'`). |
| `OBSERVED` | Collected live from the equipment / adapter / gateway (including a stale recorder observation). |
| `DECLARED` | Entered by a human in the inventory; not observed. |

## Precedence

For every identity / network field, Device Intelligence walks an **ordered
candidate list** and takes the **first candidate that actually has a value**:

1. Value observed on the device's primary source (see the source table above),
   with its real `confidence` (`VERIFIED` for recorder-verified, else
   `OBSERVED`).
2. Adapter `details` value (for `hardwareVersion` / `apiVersion` /
   `onvifVersion` — always `ADAPTER` / `OBSERVED`).
3. Inventory value (`INVENTORY` / `DECLARED`).
4. `null` (`source: null`, `confidence: null`).

**A confident fallback is never overwritten by a `null` observed value.** If the
recorder stops returning a firmware string for a channel, the projection falls
back to the inventory firmware rather than reporting `null`. (The recorder
observation snapshot itself also keeps the last non-null value it received —
Prisma treats an omitted field as "no change".)

An **observed** value always beats an **inventory** value when both exist
(e.g. a recorder-reported `DS-2CD2123G0-I` replaces a stale inventory model).

## Provenance / evidence

`identity.*` and `network.*` are `IntelligenceField`s:

```jsonc
{ "value": "DS-2CD2123G0-I", "source": "RECORDER", "confidence": "VERIFIED",
  "observerDeviceId": "…", "observedAt": "2026-08-30T12:00:00.000Z" }
```

`evidence[]` is a **curated, data-driven** list — it does not echo every field.
Items are only emitted when the underlying data is present:

| subject | emitted when |
|---|---|
| `connectivity` | there is an operational snapshot |
| `model` / `firmware` | a value was observed (not from inventory) |
| `storage` | `capabilities.storage.state === 'NOT_INSTALLED'` |
| `poePower` | a recorder observation carries `poePowerW` |
| `poeBudget` | recorder `details.poeUsedPowerW` is present |
| `collection` | the Health Engine reported a collection issue |

Each evidence item carries as much as is available of: `source`, `confidence`,
`observerDeviceId`, `observerDeviceName`, `channelNumber`, `observedAt`,
`detail`. Nothing is invented.

## Freshness

Device Intelligence reuses the Health Engine windows — it does **not** add a
second freshness system. `connectivity.ageSeconds` and
`connectivity.offlineAfterSeconds` are the raw numbers; `freshness.state`
summarises them:

| `freshness.state` | Meaning | Derived from |
|---|---|---|
| `FRESH` | Inside the window; last observation is current. | `linkState === 'ONLINE'` |
| `STALE` | Telemetry / observation exists but is outside the window. | `linkState` `OFFLINE` (heartbeat overdue) or `UNKNOWN` (stale observation) **with** a `lastObservedAt` |
| `UNKNOWN` | Nothing was ever observed, or the device is not monitored. | `linkState` `NEVER_SEEN` / `null`, or no operational snapshot |

`observedAt` (when the device/recorder observed the data) is distinct from
`receivedAt` (when the PSOP API stored it).

## `null` vs `UNKNOWN` vs `NOT_APPLICABLE`

| | Meaning |
|---|---|
| **`null`** (a field value) | The value *could* exist for this device, but PSOP has not obtained it — e.g. a camera firmware that has not been enriched, a MAC that no path exposes. |
| **`UNKNOWN`** (a dimension state) | PSOP *tried* to assess it and cannot conclude — e.g. `linkState = UNKNOWN` (stale observation / invalid timestamp), `health = UNKNOWN` (link not ONLINE). |
| **`NOT_APPLICABLE`** (a dimension state) | The dimension does not apply to this device class — e.g. `capabilities.storage` on a plain camera, `collection` with no adapter involved. |

`connectivity` / `health` / `collection` states are `null` (not `UNKNOWN`) only
when the device is not monitored at all (`INVENTORY_ONLY`, or a device type with
no telemetry path). `capabilities` is `null` in the same case.

## What is NOT inferred

- **MAC address** — no monitoring path sends a MAC to the API and there is no
  inventory column. Always `null`. (The generic gateway can *verify* a MAC
  locally during an ICMP probe, but only the pass/fail reaches the API.)
- **Serial number** — no adapter collects it (the Speco adapter explicitly
  excludes it). Inventory only.
- **Child camera capabilities / firmware / health / identity** that a recorder
  does not actually report — left `null` / `UNKNOWN` / `NOT_APPLICABLE`.
- **Mapped / expected channel count** for a recorder — lives in the gateway
  mapping file, not sent to the API. Only `observedChannelCount` and
  `onlineChannelCount` are available.
- A child camera's health is **never** made to depend on its gateway's health
  beyond the behaviour the Health Engine already implements from real data.

## Real-lab examples

### Speco NVR (no HDD)

```jsonc
{
  "device": { "deviceType": "RECORDER", "monitoringMode": "DIRECT" },
  "connectivity": { "linkState": "ONLINE", "legacyState": "ONLINE",
                    "freshness": "FRESH" },
  "health":      { "state": "HEALTHY", "reasons": [] },
  "collection":  { "state": "PARTIAL",
                   "issues": [{ "code": "OPTIONAL_ENRICHMENT_UNAVAILABLE" }] },
  "capabilities": {
    "storage":   { "supported": true, "present": false, "state": "NOT_INSTALLED" },
    "recording": { "state": "NOT_AVAILABLE_NO_STORAGE" }
  },
  "identity": {
    "manufacturer": { "value": "Speco Technologies", "source": "INVENTORY",
                      "confidence": "DECLARED" },
    "model":        { "value": "N8NRL", "source": "ADAPTER",
                      "confidence": "OBSERVED" },
    "firmware":     { "value": "1.0.0.0", "source": "ADAPTER" },
    "hardwareVersion": { "value": "1A", "source": "ADAPTER" },
    "serialNumber": { "value": null, "source": null }
  },
  "recorderHost": { "storageState": "NOT_INSTALLED", "diskCount": 0,
                    "poeTotalPowerW": 120, "poeUsedPowerW": 29.5,
                    "observedChannelCount": 3, "onlineChannelCount": 3 },
  "recorderChannel": null,
  "evidence": [
    { "subject": "connectivity", "value": "ONLINE", "source": "ADAPTER" },
    { "subject": "storage", "value": "NOT_INSTALLED",
      "detail": "recorder reports no disk installed — not a fault" },
    { "subject": "poeBudget", "value": 29.5, "source": "ADAPTER",
      "detail": "PoE budget: 29.5 W used of 120 W" },
    { "subject": "collection", "value": "OPTIONAL_ENRICHMENT_UNAVAILABLE" }
  ]
}
```

No HDD is a capability state, not a fault: `health` stays `HEALTHY`, no incident.

### Hikvision via the Speco recorder

```jsonc
{
  "monitoring": { "mode": "VIA_GATEWAY", "source": "RECORDER_OBSERVED",
                  "verification": "RECORDER_VERIFIED",
                  "observerDeviceId": "…", "observerDeviceName": "NVR Speco",
                  "channelNumber": 1, "poePort": 1 },
  "connectivity": { "linkState": "ONLINE", "freshness": "FRESH" },
  "identity": {
    "model":    { "value": "DS-2CD2123G0-I", "source": "RECORDER",
                  "confidence": "VERIFIED", "observerDeviceId": "…" },
    "firmware": { "value": "V5.5.82 build 190909", "source": "RECORDER",
                  "confidence": "VERIFIED" }
  },
  "recorderChannel": { "channelNumber": 1, "poePort": 1, "poePowerW": 3.2,
                       "bitrateKbps": 3072, "frameRate": 30,
                       "resolution": "1920x1080",
                       "recordingState": "NOT_AVAILABLE_NO_STORAGE",
                       "observerDeviceName": "NVR Speco" },
  "network": { "protocols": ["ONVIF"], "macAddress": { "value": null } }
}
```

If `queryIPChlInfo` / vendor enrichment never yielded a firmware and inventory
has none: `identity.firmware = { value: null, source: null }`,
`collection.state = PARTIAL`, `connectivity` stays `ONLINE`, `health` stays
`HEALTHY`, and `limitations` explains the gap. Firmware is never invented.

When the recorder drops the channel: `linkState = OFFLINE`,
`health = CRITICAL`, reasons `REPORTED_OFFLINE` + `RECORDER_VERIFIED_OFFLINE`,
`freshness = STALE`. On the next `online` observation it recovers.

### Lorex Home Center (generic gateway) and its child

Home Center — `DIRECT` `GATEWAY`, ICMP probe:

```jsonc
{
  "connectivity": { "linkState": "ONLINE", "freshness": "FRESH" },
  "identity": { "manufacturer": { "value": "Lorex", "source": "INVENTORY" },
                "model": { "value": "Lorex … L871T8", "source": "GATEWAY" },
                "firmware": { "value": null, "source": null } },
  "network": { "ipAddress": { "value": "192.168.0.118", "source": "INVENTORY" },
               "macAddress": { "value": null }, "protocols": [] },
  "capabilities": { "storage": { "state": "NOT_APPLICABLE" },
                    "recording": { "state": "NOT_APPLICABLE" } },
  "recorderChannel": null, "recorderHost": null
}
```

Lorex child camera (`VIA_GATEWAY`, no recorder observation):

```jsonc
{
  "connectivity": { "linkState": "NEVER_SEEN", "freshness": "UNKNOWN" },
  "health": { "state": "UNKNOWN" }, "collection": { "state": "NOT_APPLICABLE" },
  "capabilities": { "storage": { "state": "NOT_APPLICABLE" },
                    "recording": { "state": "NOT_APPLICABLE" } },
  "identity": { "model": { "value": null }, "firmware": { "value": null } },
  "recorderChannel": null, "evidence": []
}
```

Nothing is inferred: no capabilities, no firmware, no per-channel state.

### `INVENTORY_ONLY` device (e.g. a door sensor)

```jsonc
{
  "device": { "deviceType": "SENSOR", "monitoringMode": "INVENTORY_ONLY" },
  "connectivity": { "linkState": null, "legacyState": null,
                    "freshness": "UNKNOWN" },
  "health": { "state": null }, "collection": { "state": null },
  "capabilities": null,
  "identity": { "manufacturer": { "value": "Generic", "source": "INVENTORY" },
                "model": { "value": "DoorContact-1", "source": "INVENTORY" } },
  "limitations": [
    "PSOP does not collect live telemetry for a SENSOR in INVENTORY_ONLY monitoring mode; …"
  ]
}
```

## Limitations of V1

- No history / trend — it is a point-in-time projection of the current
  snapshots.
- Lorex is not reverse-engineered further; a Lorex child stays inventory-only
  until a real per-channel source exists.
- `manufacturer` for adapter-collected devices comes from inventory (the
  adapters do not report it).
