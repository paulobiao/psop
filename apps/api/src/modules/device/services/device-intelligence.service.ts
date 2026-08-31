import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  DeviceTelemetrySnapshot,
  RecorderObservationSnapshot,
} from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { OperationalCapabilities } from '../domain/operational-health.types.js';
import {
  NULL_FIELD,
  type DeviceIntelligence,
  type DeviceIntelligenceRecorderChannel,
  type DeviceIntelligenceRecorderHost,
  type EvidenceConfidence,
  type EvidenceSource,
  type FreshnessState,
  type IntelligenceEvidence,
  type IntelligenceField,
} from '../domain/device-intelligence.types.js';
import {
  DeviceRepository,
  type DeviceWithSite,
} from '../repositories/device.repository.js';
import { DeviceTelemetryService } from './device-telemetry.service.js';

type OperationalSnapshot = Awaited<
  ReturnType<DeviceTelemetryService['findByDeviceId']>
>;

/**
 * The monitoring path that produced this device's live data. It is derived
 * deterministically from the inventory model (mode + type), never guessed.
 */
type PrimarySource =
  | 'RECORDER'
  | 'ADAPTER'
  | 'GATEWAY'
  | 'DEVICE'
  | 'NONE';

@Injectable()
export class DeviceIntelligenceService {
  constructor(
    private readonly deviceRepository: DeviceRepository,
    private readonly deviceTelemetryService: DeviceTelemetryService,
    private readonly prisma: PrismaService,
  ) {}

  async getIntelligence(
    deviceId: string,
    organizationId: string,
  ): Promise<DeviceIntelligence> {
    const device = await this.deviceRepository.findByIdWithSite(
      deviceId,
      organizationId,
    );

    // Tenant isolation: a device outside the caller's organization is
    // indistinguishable from one that does not exist.
    if (!device) {
      throw new NotFoundException('Device not found');
    }

    const eligible = this.supportsOperationalSnapshot(device);

    const operational: OperationalSnapshot | null = eligible
      ? await this.deviceTelemetryService.findByDeviceId(
          deviceId,
          organizationId,
        )
      : null;

    const rawTelemetry =
      device.monitoringMode === 'DIRECT'
        ? await this.prisma.deviceTelemetrySnapshot.findUnique({
            where: { deviceId },
          })
        : null;

    const rawObservationRow =
      device.monitoringMode === 'VIA_GATEWAY'
        ? await this.prisma.recorderObservationSnapshot.findUnique({
            where: { deviceId },
          })
        : null;

    // Only trust an observation that still belongs to the device's current
    // gateway — exactly the guard the telemetry service applies.
    const rawObservation =
      rawObservationRow &&
      rawObservationRow.recorderDeviceId === device.gatewayDeviceId
        ? rawObservationRow
        : null;

    const observer = rawObservation
      ? await this.prisma.device.findFirst({
          where: {
            id: rawObservation.recorderDeviceId,
            deletedAt: null,
          },
          select: { id: true, name: true },
        })
      : null;

    const observerDeviceName = observer?.name ?? null;

    const primarySource = this.resolvePrimarySource(
      device,
      rawTelemetry,
      rawObservation,
    );

    const verified =
      operational?.monitoring.individualVerification === 'RECORDER_VERIFIED';

    const primaryObservedAt = this.primaryObservedAt(
      rawTelemetry,
      rawObservation,
    );
    const primaryReceivedAt = this.iso(
      rawTelemetry?.receivedAt ?? rawObservation?.receivedAt ?? null,
    );

    const details = this.asObject(rawTelemetry?.details);

    const identity = this.buildIdentity(
      device,
      rawTelemetry,
      rawObservation,
      details,
      primarySource,
      verified,
      primaryObservedAt,
    );

    const capabilities: OperationalCapabilities | null =
      operational?.capabilities ?? null;

    const freshnessState = this.freshness(operational);

    const evidence = this.buildEvidence(
      device,
      operational,
      rawTelemetry,
      rawObservation,
      details,
      observerDeviceName,
      primarySource,
      verified,
      primaryObservedAt,
    );

    const limitations = this.buildLimitations(
      device,
      eligible,
      operational,
      identity,
      rawObservation,
      capabilities,
    );

    return {
      generatedAt: new Date().toISOString(),
      device: {
        id: device.id,
        name: device.name,
        externalId: device.externalId,
        deviceType: device.deviceType,
        administrativeStatus: device.status,
        monitoringMode: device.monitoringMode,
        site: {
          id: device.site.id,
          code: device.site.code,
          name: device.site.name,
        },
      },
      identity,
      monitoring: {
        mode: device.monitoringMode,
        source: operational?.monitoring.source ?? 'NOT_MONITORED',
        verification:
          operational?.monitoring.individualVerification ?? 'NOT_MONITORED',
        observerDeviceId:
          operational?.monitoring.observerDeviceId ??
          rawObservation?.recorderDeviceId ??
          null,
        observerDeviceName,
        channelId:
          operational?.telemetry?.channelId ??
          rawObservation?.channelId ??
          null,
        channelNumber:
          operational?.telemetry?.channelNumber ??
          rawObservation?.channelNumber ??
          null,
        poePort:
          operational?.telemetry?.poePort ?? rawObservation?.poePort ?? null,
      },
      connectivity: {
        linkState: operational?.connectivity.linkState ?? null,
        legacyState: operational?.connectivity.state ?? null,
        lastObservedAt: operational?.connectivity.lastObservedAt ?? null,
        receivedAt: primaryReceivedAt,
        ageSeconds: operational?.connectivity.ageSeconds ?? null,
        offlineAfterSeconds:
          operational?.connectivity.offlineAfterSeconds ?? null,
        freshness: freshnessState,
        reasons: operational?.connectivity.reasons ?? [],
        reasonRefs: operational?.connectivity.reasonRefs ?? [],
      },
      health: {
        state: operational?.health.state ?? null,
        reasons: operational?.health.reasons ?? [],
      },
      collection: {
        state: operational?.collection.state ?? null,
        issues: operational?.collection.issues ?? [],
      },
      capabilities,
      network: {
        ipAddress: this.declaredField(device.ipAddress),
        // No monitoring path currently exposes a MAC to the API, and the
        // inventory has no MAC column. Always null — never inferred.
        macAddress: { ...NULL_FIELD },
        protocols: rawObservation?.protocol ? [rawObservation.protocol] : [],
      },
      recorderChannel: this.buildRecorderChannel(
        rawObservation,
        operational,
        observerDeviceName,
        primaryReceivedAt,
      ),
      recorderHost: this.buildRecorderHost(device, details, primaryObservedAt),
      freshness: {
        observedAt: primaryObservedAt,
        receivedAt: primaryReceivedAt,
        ageSeconds: operational?.connectivity.ageSeconds ?? null,
        state: freshnessState,
      },
      evidence,
      limitations,
    };
  }

  // ---------------------------------------------------------------------------
  // eligibility / source resolution
  // ---------------------------------------------------------------------------

  /** Mirrors `DeviceTelemetryService.findByDeviceId` eligibility exactly. */
  private supportsOperationalSnapshot(device: DeviceWithSite): boolean {
    const isDirect =
      device.monitoringMode === 'DIRECT' &&
      ['CAMERA', 'RECORDER', 'GATEWAY'].includes(device.deviceType);

    const isRecorderObserved =
      device.monitoringMode === 'VIA_GATEWAY' &&
      device.deviceType === 'CAMERA' &&
      Boolean(device.gatewayDeviceId);

    return isDirect || isRecorderObserved;
  }

  private resolvePrimarySource(
    device: DeviceWithSite,
    rawTelemetry: DeviceTelemetrySnapshot | null,
    rawObservation: RecorderObservationSnapshot | null,
  ): PrimarySource {
    if (device.monitoringMode === 'VIA_GATEWAY') {
      return rawObservation ? 'RECORDER' : 'NONE';
    }

    if (device.monitoringMode === 'DIRECT') {
      if (!rawTelemetry) {
        return 'NONE';
      }

      // In PSOP a recorder is always read by a protocol adapter; a gateway
      // device is an edge reachability probe; a directly monitored camera
      // runs an edge agent on/for the equipment itself.
      if (device.deviceType === 'RECORDER') {
        return 'ADAPTER';
      }
      if (device.deviceType === 'GATEWAY') {
        return 'GATEWAY';
      }
      return 'DEVICE';
    }

    return 'NONE';
  }

  private sourceToEvidence(source: PrimarySource): EvidenceSource {
    return source === 'NONE' ? 'API' : source;
  }

  private confidenceFor(
    source: PrimarySource,
    verified: boolean,
  ): EvidenceConfidence {
    if (source === 'RECORDER') {
      return verified ? 'VERIFIED' : 'OBSERVED';
    }
    return 'OBSERVED';
  }

  // ---------------------------------------------------------------------------
  // identity
  // ---------------------------------------------------------------------------

  private buildIdentity(
    device: DeviceWithSite,
    rawTelemetry: DeviceTelemetrySnapshot | null,
    rawObservation: RecorderObservationSnapshot | null,
    details: Record<string, unknown> | null,
    primarySource: PrimarySource,
    verified: boolean,
    observedAt: string | null,
  ): DeviceIntelligence['identity'] {
    const observedSource = this.sourceToEvidence(primarySource);
    const observedConfidence = this.confidenceFor(primarySource, verified);

    const observedModel =
      rawObservation?.model ?? rawTelemetry?.model ?? null;
    const observedFirmware =
      rawObservation?.firmware ?? rawTelemetry?.firmware ?? null;

    return {
      // The adapters do not report a manufacturer; it lives in the inventory.
      manufacturer: this.declaredField(device.manufacturer),
      model: this.pick(
        {
          value: observedModel,
          source: observedSource,
          confidence: observedConfidence,
          observerDeviceId: rawObservation?.recorderDeviceId ?? null,
          observedAt,
        },
        this.declaredField(device.model),
      ),
      firmware: this.pick(
        {
          value: observedFirmware,
          source: observedSource,
          confidence: observedConfidence,
          observerDeviceId: rawObservation?.recorderDeviceId ?? null,
          observedAt,
        },
        this.declaredField(device.firmwareVersion),
      ),
      // No adapter sends a serial number (explicitly excluded from telemetry).
      serialNumber: this.declaredField(device.serialNumber),
      hardwareVersion: this.pick(
        {
          value: this.str(details?.hardwareVersion),
          source: 'ADAPTER',
          confidence: 'OBSERVED',
          observerDeviceId: null,
          observedAt,
        },
        NULL_FIELD,
      ),
      apiVersion: this.pick(
        {
          value: this.str(details?.apiVersion),
          source: 'ADAPTER',
          confidence: 'OBSERVED',
          observerDeviceId: null,
          observedAt,
        },
        NULL_FIELD,
      ),
      onvifVersion: this.pick(
        {
          value: this.str(details?.onvifVersion),
          source: 'ADAPTER',
          confidence: 'OBSERVED',
          observerDeviceId: null,
          observedAt,
        },
        NULL_FIELD,
      ),
    };
  }

  /**
   * Deterministic precedence: take the first candidate that actually has a
   * value. A confident fallback is never overwritten by a null "observed"
   * value.
   */
  private pick(
    ...candidates: Array<{
      value: string | null;
      source: EvidenceSource | null;
      confidence: EvidenceConfidence | null;
      observerDeviceId: string | null;
      observedAt: string | null;
    }>
  ): IntelligenceField {
    for (const candidate of candidates) {
      if (candidate.value !== null && candidate.value !== undefined) {
        return {
          value: candidate.value,
          source: candidate.source,
          confidence: candidate.confidence,
          observerDeviceId: candidate.observerDeviceId,
          observedAt: candidate.observedAt,
        };
      }
    }
    return { ...NULL_FIELD };
  }

  private declaredField(value: string | null): IntelligenceField {
    if (!value) {
      return { ...NULL_FIELD };
    }
    return {
      value,
      source: 'INVENTORY',
      confidence: 'DECLARED',
      observerDeviceId: null,
      observedAt: null,
    };
  }

  // ---------------------------------------------------------------------------
  // freshness
  // ---------------------------------------------------------------------------

  private freshness(
    operational: OperationalSnapshot | null,
  ): FreshnessState {
    if (!operational) {
      return 'UNKNOWN';
    }

    const link = operational.connectivity.linkState;

    if (link === 'ONLINE') {
      return 'FRESH';
    }
    if (link === 'OFFLINE' || link === 'UNKNOWN') {
      // OFFLINE here is heartbeat-overdue; UNKNOWN is a stale observation or an
      // invalid timestamp — in every case we last heard something too old.
      return operational.connectivity.lastObservedAt ? 'STALE' : 'UNKNOWN';
    }
    // NEVER_SEEN
    return 'UNKNOWN';
  }

  // ---------------------------------------------------------------------------
  // recorder views
  // ---------------------------------------------------------------------------

  private buildRecorderChannel(
    rawObservation: RecorderObservationSnapshot | null,
    operational: OperationalSnapshot | null,
    observerDeviceName: string | null,
    receivedAt: string | null,
  ): DeviceIntelligenceRecorderChannel | null {
    if (!rawObservation) {
      return null;
    }

    return {
      observerDeviceId: rawObservation.recorderDeviceId,
      observerDeviceName,
      channelId: rawObservation.channelId,
      channelNumber: rawObservation.channelNumber,
      poePort: rawObservation.poePort,
      poePowerW: rawObservation.poePowerW,
      bitrateKbps: rawObservation.bitrateKbps,
      frameRate: rawObservation.frameRate,
      resolution: rawObservation.resolution,
      recordingState:
        operational?.capabilities?.recording.state ??
        rawObservation.recordingStatus ??
        null,
      observedAt: this.iso(rawObservation.observedAt),
      receivedAt,
    };
  }

  private buildRecorderHost(
    device: DeviceWithSite,
    details: Record<string, unknown> | null,
    observedAt: string | null,
  ): DeviceIntelligenceRecorderHost | null {
    if (device.deviceType !== 'RECORDER' || !details) {
      return null;
    }

    return {
      storageState: this.str(details.storageState),
      storagePresent: this.bool(details.storagePresent),
      diskCount: this.num(details.diskCount),
      poeTotalPowerW: this.num(details.poeTotalPowerW),
      poeRemainingPowerW: this.num(details.poeRemainingPowerW),
      poeUsedPowerW: this.num(details.poeUsedPowerW),
      observedChannelCount: this.num(details.observedChannelCount),
      onlineChannelCount: this.num(details.onlineChannelCount),
      observedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // evidence
  // ---------------------------------------------------------------------------

  private buildEvidence(
    device: DeviceWithSite,
    operational: OperationalSnapshot | null,
    rawTelemetry: DeviceTelemetrySnapshot | null,
    rawObservation: RecorderObservationSnapshot | null,
    details: Record<string, unknown> | null,
    observerDeviceName: string | null,
    primarySource: PrimarySource,
    verified: boolean,
    observedAt: string | null,
  ): IntelligenceEvidence[] {
    const evidence: IntelligenceEvidence[] = [];
    const evSource = this.sourceToEvidence(primarySource);
    const evConfidence = this.confidenceFor(primarySource, verified);
    const observerDeviceId = rawObservation?.recorderDeviceId ?? null;
    const channelNumber =
      rawObservation?.channelNumber ??
      operational?.telemetry?.channelNumber ??
      null;

    // 1. connectivity observation
    if (operational && primarySource !== 'NONE') {
      evidence.push({
        subject: 'connectivity',
        value: operational.connectivity.linkState,
        source: evSource,
        confidence: evConfidence,
        observerDeviceId,
        observerDeviceName,
        channelNumber,
        observedAt,
        detail:
          primarySource === 'RECORDER'
            ? 'recorder channel status (queryOnlineChlList)'
            : primarySource === 'GATEWAY'
              ? 'edge gateway reachability probe'
              : 'direct telemetry heartbeat',
      });
    }

    // 2. model discovered by the recorder / adapter
    const observedModel = rawObservation?.model ?? rawTelemetry?.model ?? null;
    if (observedModel) {
      evidence.push({
        subject: 'model',
        value: observedModel,
        source: evSource,
        confidence: evConfidence,
        observerDeviceId,
        observerDeviceName,
        channelNumber,
        observedAt,
        detail:
          primarySource === 'RECORDER'
            ? 'model reported by the recorder device list'
            : 'model reported in direct telemetry',
      });
    }

    // 3. firmware discovered by an adapter / recorder proxy
    const observedFirmware =
      rawObservation?.firmware ?? rawTelemetry?.firmware ?? null;
    if (observedFirmware) {
      evidence.push({
        subject: 'firmware',
        value: observedFirmware,
        source: evSource,
        confidence: evConfidence,
        observerDeviceId,
        observerDeviceName,
        channelNumber,
        observedAt,
        detail:
          primarySource === 'RECORDER'
            ? 'firmware enriched via the recorder proxy (vendor API)'
            : 'firmware reported in direct telemetry',
      });
    }

    // 4. storage NOT_INSTALLED reported by the recorder
    if (operational?.capabilities?.storage.state === 'NOT_INSTALLED') {
      evidence.push({
        subject: 'storage',
        value: 'NOT_INSTALLED',
        source: evSource === 'API' ? 'ADAPTER' : evSource,
        confidence: 'OBSERVED',
        observerDeviceId,
        observerDeviceName,
        channelNumber: null,
        observedAt,
        detail: 'recorder reports no disk installed — not a fault',
      });
    }

    // 5. PoE observations
    if (rawObservation?.poePowerW != null) {
      evidence.push({
        subject: 'poePower',
        value: rawObservation.poePowerW,
        source: 'RECORDER',
        confidence: verified ? 'VERIFIED' : 'OBSERVED',
        observerDeviceId,
        observerDeviceName,
        channelNumber: rawObservation.channelNumber,
        observedAt: this.iso(rawObservation.observedAt),
        detail:
          rawObservation.poePort != null
            ? `PoE port ${rawObservation.poePort} draws ${rawObservation.poePowerW} W`
            : `channel draws ${rawObservation.poePowerW} W`,
      });
    }

    const poeUsed = this.num(details?.poeUsedPowerW);
    const poeTotal = this.num(details?.poeTotalPowerW);
    if (poeUsed != null) {
      evidence.push({
        subject: 'poeBudget',
        value: poeUsed,
        source: 'ADAPTER',
        confidence: 'OBSERVED',
        observerDeviceId: null,
        observerDeviceName: null,
        channelNumber: null,
        observedAt,
        detail:
          poeTotal != null
            ? `PoE budget: ${poeUsed} W used of ${poeTotal} W`
            : `PoE draw: ${poeUsed} W`,
      });
    }

    // 6. collection-quality issues (diagnostics only)
    for (const issue of operational?.collection.issues ?? []) {
      evidence.push({
        subject: 'collection',
        value: issue.code,
        source: (issue.source as EvidenceSource) ?? 'ADAPTER',
        confidence: 'OBSERVED',
        observerDeviceId: issue.observerDeviceId ?? null,
        observerDeviceName: null,
        channelNumber: issue.channelNumber ?? null,
        observedAt,
        detail: issue.detail ?? null,
      });
    }

    return evidence;
  }

  // ---------------------------------------------------------------------------
  // limitations
  // ---------------------------------------------------------------------------

  private buildLimitations(
    device: DeviceWithSite,
    eligible: boolean,
    operational: OperationalSnapshot | null,
    identity: DeviceIntelligence['identity'],
    rawObservation: RecorderObservationSnapshot | null,
    capabilities: OperationalCapabilities | null,
  ): string[] {
    const limitations: string[] = [];

    if (!eligible) {
      limitations.push(
        `PSOP does not collect live telemetry for a ${device.deviceType} in ` +
          `${device.monitoringMode} monitoring mode; connectivity, health and ` +
          `collection quality are not available for this device.`,
      );
    }

    if (
      eligible &&
      device.monitoringMode === 'VIA_GATEWAY' &&
      !rawObservation
    ) {
      limitations.push(
        'This camera is monitored via a gateway that has not produced a ' +
          'per-channel observation yet; its identity and connectivity beyond ' +
          'the inventory are unknown.',
      );
    }

    if (identity.firmware.value === null) {
      limitations.push(
        'Firmware is unknown: it was not observed from the equipment ' +
          (device.monitoringMode === 'VIA_GATEWAY'
            ? '(recorder-proxy vendor enrichment unavailable) '
            : '') +
          'and none is declared in inventory. It is never inferred.',
      );
    }

    if (identity.serialNumber.value === null) {
      limitations.push(
        'Serial number is not collected by any adapter and is not declared ' +
          'in inventory.',
      );
    }

    limitations.push(
      'MAC address is not exposed to the API by any current monitoring path ' +
        'and has no inventory field; it is always null here.',
    );

    if (
      !capabilities ||
      (capabilities.storage.state === 'NOT_APPLICABLE' &&
        capabilities.recording.state === 'NOT_APPLICABLE')
    ) {
      limitations.push(
        'Storage and recording capability are NOT_APPLICABLE for this device: ' +
          'no adapter reports physical storage for it.',
      );
    }

    if (device.deviceType === 'RECORDER') {
      limitations.push(
        'The mapped / expected channel count lives in the gateway mapping ' +
          'file and is not sent to the API; only observed and online channel ' +
          'counts are available.',
      );
    }

    if (
      operational &&
      operational.connectivity.linkState === 'UNKNOWN' &&
      operational.connectivity.reasons.includes('STALE_OBSERVATION')
    ) {
      limitations.push(
        'The last recorder observation is outside the freshness window; the ' +
          'channel state is reported as UNKNOWN rather than assumed online.',
      );
    }

    return limitations;
  }

  // ---------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------

  private primaryObservedAt(
    rawTelemetry: DeviceTelemetrySnapshot | null,
    rawObservation: RecorderObservationSnapshot | null,
  ): string | null {
    return this.iso(
      rawObservation?.observedAt ?? rawTelemetry?.observedAt ?? null,
    );
  }

  private iso(value: Date | null | undefined): string | null {
    return value ? value.toISOString() : null;
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private str(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  private num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private bool(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
  }
}
