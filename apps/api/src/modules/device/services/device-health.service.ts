import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_CAPABILITIES,
  toCompatConnectivityState,
  type CollectionState,
  type ConnectivityState,
  type HealthState,
  type LinkState,
  type OperationalCapabilities,
  type ReasonCode,
  type ReasonRef,
  type ReasonSource,
} from '../domain/operational-health.types.js';

export type {
  ConnectivityState,
  LinkState,
  HealthState,
  CollectionState,
  ReasonRef,
  ReasonCode,
} from '../domain/operational-health.types.js';

/**
 * Legacy alias kept so existing imports of `DeviceHealthReason` keep compiling.
 * The new code uses the structured `ReasonRef` / `ReasonCode` types.
 */
export type DeviceHealthReason = ReasonCode;

export interface DeviceHealthInput {
  hasTelemetry: boolean;
  timestampSeconds: number | null;
  expectedHeartbeatIntervalSeconds: number;
  reportedStatus: string | null;
  reportedOfflineIsAuthoritative?: boolean;
  staleTelemetryIsUnknown?: boolean;
  temperatureC: number | null;
  storageUsedPct: number | null;
  nowSeconds?: number;

  // --- V2 additions (all optional / backward compatible) ---
  /** True for recorder-observed cameras — drives RECORDER_VERIFIED_OFFLINE. */
  isRecorderObserved?: boolean;
  /** Identity evidence attached to link reasons when available. */
  observerDeviceId?: string | null;
  channelNumber?: number | null;
  /** Collection quality reported by the adapter / gateway. */
  collectionState?: CollectionState | null;
  collectionIssues?: ReasonRef[] | null;
  /** Storage / recording capability snapshot reported by the adapter. */
  capabilities?: OperationalCapabilities | null;
}

export interface OperationalConnectivity {
  /** True connectivity dimension. */
  linkState: LinkState;
  /** Compatibility alias — collapses health DEGRADED/CRITICAL into DEGRADED. */
  state: ConnectivityState;
  /** Structured link reasons. */
  reasons: ReasonRef[];
  /** Plain string projection for the frozen dashboard / persisted context. */
  legacyReasons: string[];
  lastHeartbeatAt: string | null;
  ageSeconds: number | null;
  offlineAfterSeconds: number;
}

export interface OperationalHealth {
  state: HealthState;
  reasons: ReasonRef[];
}

export interface OperationalCollection {
  state: CollectionState;
  issues: ReasonRef[];
}

export interface DeviceHealthResult {
  connectivity: OperationalConnectivity;
  health: OperationalHealth;
  collection: OperationalCollection;
  capabilities: OperationalCapabilities;
}

@Injectable()
export class DeviceHealthService {
  private readonly offlineMultiplier: number;
  private readonly degradedTemperatureC: number;
  private readonly degradedStorageUsedPct: number;

  constructor(configService: ConfigService) {
    this.offlineMultiplier = this.positiveNumber(
      configService.get<string>('TELEMETRY_OFFLINE_MULTIPLIER'),
      2,
    );

    this.degradedTemperatureC = this.positiveNumber(
      configService.get<string>('TELEMETRY_DEGRADED_TEMPERATURE_C'),
      70,
    );

    this.degradedStorageUsedPct = this.positiveNumber(
      configService.get<string>('TELEMETRY_DEGRADED_STORAGE_USED_PCT'),
      90,
    );
  }

  evaluate(input: DeviceHealthInput): DeviceHealthResult {
    const offlineAfterSeconds =
      Math.max(1, input.expectedHeartbeatIntervalSeconds) *
      this.offlineMultiplier;

    const capabilities = input.capabilities ?? DEFAULT_CAPABILITIES;
    const collection = this.evaluateCollection(input);

    const linkSource: ReasonSource = input.isRecorderObserved
      ? 'RECORDER'
      : 'DEVICE';

    const evidence = {
      source: linkSource,
      observerDeviceId: input.observerDeviceId ?? null,
      channelNumber: input.channelNumber ?? null,
    };

    // ---- NEVER_SEEN --------------------------------------------------------
    if (!input.hasTelemetry) {
      return this.result(
        {
          linkState: 'NEVER_SEEN',
          reasons: [this.reason('NO_TELEMETRY', evidence)],
          lastHeartbeatAt: null,
          ageSeconds: null,
          offlineAfterSeconds,
        },
        { state: 'UNKNOWN', reasons: [] },
        collection,
        capabilities,
      );
    }

    // ---- invalid timestamp ----------------------------------------------
    if (input.timestampSeconds === null) {
      return this.result(
        {
          linkState: 'UNKNOWN',
          reasons: [this.reason('INVALID_TIMESTAMP', evidence)],
          lastHeartbeatAt: null,
          ageSeconds: null,
          offlineAfterSeconds,
        },
        { state: 'UNKNOWN', reasons: [] },
        collection,
        capabilities,
      );
    }

    const nowSeconds =
      input.nowSeconds ?? Math.floor(Date.now() / 1000);

    const ageSeconds = Math.max(
      0,
      nowSeconds - input.timestampSeconds,
    );

    const lastHeartbeatAt = new Date(
      input.timestampSeconds * 1000,
    ).toISOString();

    // ---- stale / heartbeat overdue ------------------------------------
    if (ageSeconds > offlineAfterSeconds) {
      if (input.staleTelemetryIsUnknown) {
        return this.result(
          {
            linkState: 'UNKNOWN',
            reasons: [this.reason('STALE_OBSERVATION', evidence)],
            lastHeartbeatAt,
            ageSeconds,
            offlineAfterSeconds,
          },
          { state: 'UNKNOWN', reasons: [] },
          collection,
          capabilities,
        );
      }

      return this.result(
        {
          linkState: 'OFFLINE',
          reasons: [this.reason('HEARTBEAT_OVERDUE', evidence)],
          lastHeartbeatAt,
          ageSeconds,
          offlineAfterSeconds,
        },
        { state: 'UNKNOWN', reasons: [] },
        collection,
        capabilities,
      );
    }

    const normalizedStatus =
      input.reportedStatus?.trim().toLowerCase() ?? null;

    // ---- authoritative reported offline ------------------------------
    if (
      normalizedStatus === 'offline' &&
      input.reportedOfflineIsAuthoritative
    ) {
      const reasons = [this.reason('REPORTED_OFFLINE', evidence)];

      if (input.isRecorderObserved) {
        reasons.push(
          this.reason('RECORDER_VERIFIED_OFFLINE', {
            ...evidence,
            source: 'RECORDER',
          }),
        );
      }

      return this.result(
        {
          linkState: 'OFFLINE',
          reasons,
          lastHeartbeatAt,
          ageSeconds,
          offlineAfterSeconds,
        },
        input.isRecorderObserved
          ? {
              // A recorder that authoritatively reports a channel offline is a
              // real operational problem for that channel.
              state: 'CRITICAL',
              reasons: [
                this.reason('CAMERA_CHANNEL_OFFLINE', {
                  ...evidence,
                  source: 'RECORDER',
                }),
              ],
            }
          : { state: 'UNKNOWN', reasons: [] },
        collection,
        capabilities,
      );
    }

    // ---- unrecognised reported status -------------------------------
    if (
      normalizedStatus &&
      !this.healthyStatuses().has(normalizedStatus) &&
      !this.degradedStatuses().has(normalizedStatus)
    ) {
      return this.result(
        {
          linkState: 'ONLINE',
          reasons: [],
          lastHeartbeatAt,
          ageSeconds,
          offlineAfterSeconds,
        },
        {
          state: 'UNKNOWN',
          reasons: [
            this.reason('UNRECOGNIZED_REPORTED_STATUS', {
              source: linkSource,
              detail: input.reportedStatus ?? null,
            }),
          ],
        },
        collection,
        capabilities,
      );
    }

    // ---- ONLINE: assess health --------------------------------------
    const healthReasons: ReasonRef[] = [];

    if (
      normalizedStatus &&
      this.degradedStatuses().has(normalizedStatus)
    ) {
      healthReasons.push(
        this.reason('DEVICE_REPORTED_WARNING', {
          source: linkSource,
          detail: normalizedStatus,
        }),
      );
    }

    if (
      input.temperatureC !== null &&
      input.temperatureC >= this.degradedTemperatureC
    ) {
      healthReasons.push(
        this.reason('HIGH_TEMPERATURE', {
          source: linkSource,
          detail: `${input.temperatureC}`,
        }),
      );
    }

    if (
      input.storageUsedPct !== null &&
      input.storageUsedPct >= this.degradedStorageUsedPct
    ) {
      healthReasons.push(
        this.reason('HIGH_STORAGE_USAGE', {
          source: linkSource,
          detail: `${input.storageUsedPct}`,
        }),
      );
    }

    // RECORDING_ABNORMAL is only meaningful once storage is physically
    // present. With no HDD the recorder legitimately reports abnormal
    // recording, so it must never degrade health here.
    if (
      capabilities.storage.present &&
      capabilities.recording.state === 'ABNORMAL'
    ) {
      healthReasons.push(
        this.reason('RECORDING_ABNORMAL', { source: linkSource }),
      );
    }

    return this.result(
      {
        linkState: 'ONLINE',
        reasons: [],
        lastHeartbeatAt,
        ageSeconds,
        offlineAfterSeconds,
      },
      {
        state: healthReasons.length > 0 ? 'DEGRADED' : 'HEALTHY',
        reasons: healthReasons,
      },
      collection,
      capabilities,
    );
  }

  private evaluateCollection(
    input: DeviceHealthInput,
  ): OperationalCollection {
    const issues = (input.collectionIssues ?? []).map((issue) => ({
      ...issue,
      source: issue.source ?? 'ADAPTER',
    }));

    if (input.collectionState) {
      // Contract invariant: `COMPLETE` means every expected source responded,
      // so it cannot coexist with an unresolved collection issue. If an adapter
      // reports `COMPLETE` while still emitting an `OPTIONAL_ENRICHMENT_-
      // UNAVAILABLE` / `COLLECTION_SOURCE_FAILED` issue, the engine reconciles
      // it down to `PARTIAL`. This never escalates to `FAILED` (an optional gap
      // is not a core-collection failure) and never touches
      // connectivity / health / incidents.
      if (input.collectionState === 'COMPLETE' && issues.length > 0) {
        return { state: 'PARTIAL', issues };
      }
      return { state: input.collectionState, issues };
    }

    if (issues.length > 0) {
      return { state: 'PARTIAL', issues };
    }

    return { state: 'NOT_APPLICABLE', issues };
  }

  private result(
    link: {
      linkState: LinkState;
      reasons: ReasonRef[];
      lastHeartbeatAt: string | null;
      ageSeconds: number | null;
      offlineAfterSeconds: number;
    },
    health: OperationalHealth,
    collection: OperationalCollection,
    capabilities: OperationalCapabilities,
  ): DeviceHealthResult {
    const allLinkReasons = link.reasons;

    return {
      connectivity: {
        linkState: link.linkState,
        state: toCompatConnectivityState(link.linkState, health.state),
        reasons: allLinkReasons,
        legacyReasons: this.compatReasons(
          link.linkState,
          allLinkReasons,
          health.reasons,
        ),
        lastHeartbeatAt: link.lastHeartbeatAt,
        ageSeconds: link.ageSeconds,
        offlineAfterSeconds: link.offlineAfterSeconds,
      },
      health,
      collection,
      capabilities,
    };
  }

  /**
   * The persisted `ConnectivityContext.reasons` (and the frozen dashboard)
   * historically saw a single flat list that mixed link + health codes,
   * because the state was collapsed. Preserve that exact projection.
   */
  private compatReasons(
    linkState: LinkState,
    linkReasons: ReasonRef[],
    healthReasons: ReasonRef[],
  ): string[] {
    const codes: ReasonCode[] = [];

    for (const reason of linkReasons) {
      codes.push(reason.code);
    }

    if (linkState === 'ONLINE') {
      for (const reason of healthReasons) {
        // CAMERA_CHANNEL_OFFLINE only ever pairs with an OFFLINE link, so it
        // never reaches here; the remaining health codes match the legacy set.
        codes.push(reason.code);
      }
    }

    const seen = new Set<string>();
    return codes.filter((code) => {
      if (seen.has(code)) {
        return false;
      }
      seen.add(code);
      return true;
    });
  }

  private reason(
    code: ReasonCode,
    evidence: {
      source: ReasonSource;
      observerDeviceId?: string | null;
      channelNumber?: number | null;
      detail?: string | null;
    },
  ): ReasonRef {
    const ref: ReasonRef = {
      code,
      source: evidence.source,
    };

    if (evidence.observerDeviceId) {
      ref.observerDeviceId = evidence.observerDeviceId;
    }

    if (
      evidence.channelNumber !== undefined &&
      evidence.channelNumber !== null
    ) {
      ref.channelNumber = evidence.channelNumber;
    }

    if (evidence.detail) {
      ref.detail = evidence.detail;
    }

    return ref;
  }

  private healthyStatuses(): Set<string> {
    return new Set(['online', 'ok', 'healthy', 'active', 'running']);
  }

  private degradedStatuses(): Set<string> {
    return new Set(['offline', 'warning', 'maintenance', 'error']);
  }

  private positiveNumber(
    value: string | undefined,
    fallback: number,
  ): number {
    const parsed = Number(value);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
