/**
 * PSOP Device Intelligence V1 — consolidated per-device projection.
 *
 * Device Intelligence does not evaluate anything on its own. It *reuses* the
 * Operational Health Engine V2 evaluation (see `operational-health.types.ts`
 * and `DeviceHealthService`) and layers three things on top:
 *
 *   - normalisation — one shape, whatever the monitoring path;
 *   - provenance    — every value carries where it came from, when it was
 *                     observed and who observed it;
 *   - freshness     — is what we know current, stale, or simply unknown.
 *
 * It never invents a value, a capability, a confidence score or a percentage.
 */

import type {
  CollectionState,
  HealthState,
  LinkState,
  OperationalCapabilities,
  ReasonRef,
} from './operational-health.types.js';

/**
 * Where a value was obtained.
 *
 *  - `DEVICE`    — the monitored equipment itself reported it (direct telemetry).
 *  - `RECORDER`  — a recorder/NVR reported it about one of its channels.
 *  - `ADAPTER`   — a protocol adapter collected it from the equipment
 *                  (e.g. the Speco N8NRL adapter reading the NVR).
 *  - `GATEWAY`   — an edge gateway derived it from reachability probes.
 *  - `INVENTORY` — a human entered it when the device was registered.
 *  - `API`       — PSOP itself derived it (timestamps, counters).
 */
export type EvidenceSource =
  | 'DEVICE'
  | 'RECORDER'
  | 'ADAPTER'
  | 'GATEWAY'
  | 'INVENTORY'
  | 'API';

/**
 * How much weight the value carries. This is a category, never a number.
 *
 *  - `VERIFIED` — a recorder authoritatively confirmed it for this channel
 *                 (`individualVerification === 'RECORDER_VERIFIED'`).
 *  - `OBSERVED` — collected live from the equipment / adapter / gateway.
 *  - `DECLARED` — entered by a human in the inventory; not observed.
 */
export type EvidenceConfidence = 'VERIFIED' | 'OBSERVED' | 'DECLARED';

/**
 * `FRESH`   — inside the Health Engine freshness window and link ONLINE.
 * `STALE`   — telemetry/observation exists but is outside the window
 *             (link OFFLINE by heartbeat, or a stale recorder observation).
 * `UNKNOWN` — nothing has ever been observed, or the device is not monitored.
 */
export type FreshnessState = 'FRESH' | 'STALE' | 'UNKNOWN';

/**
 * A single normalised field plus its provenance.
 *
 * `value === null` means "PSOP does not have this value" — and then `source`
 * and `confidence` are also `null`. It is deliberately distinct from a
 * dimension being `UNKNOWN` (assessed, inconclusive) or `NOT_APPLICABLE`
 * (does not apply to this device class).
 */
export interface IntelligenceField<T = string> {
  value: T | null;
  source: EvidenceSource | null;
  confidence: EvidenceConfidence | null;
  observerDeviceId: string | null;
  observedAt: string | null;
}

export interface IntelligenceEvidence {
  /** Which fact this evidence is about (e.g. `connectivity`, `model`, `storage`). */
  subject: string;
  value: string | number | boolean | null;
  source: EvidenceSource;
  confidence: EvidenceConfidence;
  observerDeviceId: string | null;
  observerDeviceName: string | null;
  channelNumber: number | null;
  observedAt: string | null;
  detail: string | null;
}

export interface DeviceIntelligenceIdentity {
  manufacturer: IntelligenceField;
  model: IntelligenceField;
  firmware: IntelligenceField;
  serialNumber: IntelligenceField;
  hardwareVersion: IntelligenceField;
  apiVersion: IntelligenceField;
  onvifVersion: IntelligenceField;
}

export interface DeviceIntelligenceMonitoring {
  mode: string;
  source: string;
  verification: string;
  observerDeviceId: string | null;
  observerDeviceName: string | null;
  channelId: string | null;
  channelNumber: number | null;
  poePort: number | null;
}

export interface DeviceIntelligenceConnectivity {
  /** The true connectivity dimension. `null` only when the device is not monitored. */
  linkState: LinkState | null;
  /** Backward-compatible 5-value alias (may carry `DEGRADED`). */
  legacyState: string | null;
  lastObservedAt: string | null;
  receivedAt: string | null;
  ageSeconds: number | null;
  offlineAfterSeconds: number | null;
  freshness: FreshnessState;
  reasons: string[];
  reasonRefs: ReasonRef[];
}

export interface DeviceIntelligenceHealth {
  state: HealthState | null;
  reasons: ReasonRef[];
}

export interface DeviceIntelligenceCollection {
  state: CollectionState | null;
  issues: ReasonRef[];
}

export interface DeviceIntelligenceNetwork {
  ipAddress: IntelligenceField;
  macAddress: IntelligenceField;
  protocols: string[];
}

/** Per-channel recorder view — only for recorder-observed cameras. */
export interface DeviceIntelligenceRecorderChannel {
  observerDeviceId: string | null;
  observerDeviceName: string | null;
  channelId: string | null;
  channelNumber: number | null;
  poePort: number | null;
  poePowerW: number | null;
  bitrateKbps: number | null;
  frameRate: number | null;
  resolution: string | null;
  recordingState: string | null;
  observedAt: string | null;
  receivedAt: string | null;
}

/** Host-recorder capacity view — only for a directly monitored RECORDER. */
export interface DeviceIntelligenceRecorderHost {
  storageState: string | null;
  storagePresent: boolean | null;
  diskCount: number | null;
  poeTotalPowerW: number | null;
  poeRemainingPowerW: number | null;
  poeUsedPowerW: number | null;
  observedChannelCount: number | null;
  onlineChannelCount: number | null;
  observedAt: string | null;
}

export interface DeviceIntelligenceFreshness {
  observedAt: string | null;
  receivedAt: string | null;
  ageSeconds: number | null;
  state: FreshnessState;
}

export interface DeviceIntelligence {
  generatedAt: string;
  device: {
    id: string;
    name: string;
    externalId: string;
    deviceType: string;
    administrativeStatus: string;
    monitoringMode: string;
    site: {
      id: string;
      code: string;
      name: string;
    };
  };
  identity: DeviceIntelligenceIdentity;
  monitoring: DeviceIntelligenceMonitoring;
  connectivity: DeviceIntelligenceConnectivity;
  health: DeviceIntelligenceHealth;
  collection: DeviceIntelligenceCollection;
  capabilities: OperationalCapabilities | null;
  network: DeviceIntelligenceNetwork;
  recorderChannel: DeviceIntelligenceRecorderChannel | null;
  recorderHost: DeviceIntelligenceRecorderHost | null;
  freshness: DeviceIntelligenceFreshness;
  evidence: IntelligenceEvidence[];
  /** Human-readable notes on what PSOP does NOT know and does not infer. */
  limitations: string[];
}

export const NULL_FIELD: IntelligenceField = {
  value: null,
  source: null,
  confidence: null,
  observerDeviceId: null,
  observedAt: null,
};
