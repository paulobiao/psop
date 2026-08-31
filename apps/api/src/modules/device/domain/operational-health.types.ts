/**
 * PSOP Operational Health Engine V2 — shared domain types.
 *
 * Three independent dimensions replace the single, semantically overloaded
 * `connectivity.state` field:
 *
 *  - LINK        — "is the device reachable / being observed inside its window?"
 *  - HEALTH      — "is the equipment operationally healthy?"
 *  - COLLECTION  — "did the adapter manage to read every expected capability?"
 *
 * The legacy 5-value `connectivity.state` is still emitted at the DTO boundary
 * as a compatibility alias (see `toCompatConnectivityState`) so the current
 * dashboard keeps working until it migrates to `connectivity.linkState` /
 * `health` / `collection`.
 */

export type LinkState = 'ONLINE' | 'OFFLINE' | 'UNKNOWN' | 'NEVER_SEEN';

export type HealthState =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'CRITICAL'
  | 'UNKNOWN';

export type CollectionState =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'FAILED'
  | 'NOT_APPLICABLE';

/**
 * Legacy union kept for the compatibility alias and the fleet summary counters.
 * It is `LinkState` plus the collapsed `DEGRADED` value.
 */
export type ConnectivityState = LinkState | 'DEGRADED';

export type ReasonCode =
  // --- link / connectivity ---
  | 'NO_TELEMETRY'
  | 'INVALID_TIMESTAMP'
  | 'HEARTBEAT_OVERDUE'
  | 'STALE_OBSERVATION'
  | 'REPORTED_OFFLINE'
  | 'RECORDER_VERIFIED_OFFLINE'
  | 'UNRECOGNIZED_REPORTED_STATUS'
  // --- health ---
  | 'HIGH_TEMPERATURE'
  | 'HIGH_STORAGE_USAGE'
  | 'DEVICE_REPORTED_WARNING'
  // health codes reserved for evidence-backed signals we do not yet emit
  | 'CAMERA_CHANNEL_OFFLINE'
  | 'RECORDING_ABNORMAL'
  | 'POE_POWER_ANOMALY'
  // --- collection quality ---
  | 'COLLECTION_SOURCE_FAILED'
  | 'OPTIONAL_ENRICHMENT_UNAVAILABLE';

export type ReasonSource =
  | 'DEVICE'
  | 'RECORDER'
  | 'GATEWAY'
  | 'ADAPTER'
  | 'API';

export interface ReasonRef {
  code: ReasonCode;
  source: ReasonSource;
  observerDeviceId?: string | null;
  channelNumber?: number | null;
  detail?: string | null;
}

export type StorageCapabilityState =
  | 'PRESENT'
  | 'NOT_INSTALLED'
  | 'UNKNOWN'
  | 'NOT_APPLICABLE';

export type RecordingCapabilityState =
  | 'AVAILABLE'
  | 'ABNORMAL'
  | 'NOT_AVAILABLE_NO_STORAGE'
  | 'UNKNOWN'
  | 'NOT_APPLICABLE';

export interface StorageCapability {
  supported: boolean;
  present: boolean;
  state: StorageCapabilityState;
}

export interface RecordingCapability {
  state: RecordingCapabilityState;
}

export interface OperationalCapabilities {
  storage: StorageCapability;
  recording: RecordingCapability;
}

export const DEFAULT_CAPABILITIES: OperationalCapabilities = {
  storage: {
    supported: false,
    present: false,
    state: 'NOT_APPLICABLE',
  },
  recording: {
    state: 'NOT_APPLICABLE',
  },
};

/** Reason codes that belong to the link / connectivity dimension. */
const LINK_REASON_CODES = new Set<ReasonCode>([
  'NO_TELEMETRY',
  'INVALID_TIMESTAMP',
  'HEARTBEAT_OVERDUE',
  'STALE_OBSERVATION',
  'REPORTED_OFFLINE',
  'RECORDER_VERIFIED_OFFLINE',
]);

export function isLinkReason(code: ReasonCode): boolean {
  return LINK_REASON_CODES.has(code);
}

/**
 * Flatten structured reasons back to the plain string list the current
 * dashboard and the persisted `ConnectivityContext.reasons` still expect.
 */
export function legacyReasonStrings(
  reasons: readonly ReasonRef[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const reason of reasons) {
    if (!seen.has(reason.code)) {
      seen.add(reason.code);
      out.push(reason.code);
    }
  }

  return out;
}

/**
 * Compatibility projection: reproduce the historical 5-value
 * `connectivity.state` from the three independent dimensions.
 *
 * Guarantees, verified against the existing test-suite:
 *  - link OFFLINE / UNKNOWN / NEVER_SEEN pass straight through
 *  - link ONLINE + health UNKNOWN (unrecognised reported status) -> UNKNOWN
 *  - link ONLINE + health DEGRADED|CRITICAL -> DEGRADED
 *  - collection quality never influences the alias
 */
export function toCompatConnectivityState(
  link: LinkState,
  health: HealthState,
): ConnectivityState {
  if (link !== 'ONLINE') {
    return link;
  }

  if (health === 'UNKNOWN') {
    return 'UNKNOWN';
  }

  if (health === 'DEGRADED' || health === 'CRITICAL') {
    return 'DEGRADED';
  }

  return 'ONLINE';
}
