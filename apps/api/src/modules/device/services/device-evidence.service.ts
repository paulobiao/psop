import type { IngestStreamEvidenceDto } from '../dto/ingest-stream-evidence.dto.js';
import {
  STREAM_LEDGER_LEVEL,
  validateStreamEvidence,
} from '../domain/stream-evidence.js';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { IngestDeviceTelemetryDto } from '../dto/ingest-device-telemetry.dto.js';
import type { RecorderObservedDeviceDto } from '../dto/ingest-recorder-observations.dto.js';
import { DeviceRepository } from '../repositories/device.repository.js';

type StreamPayload = Pick<
  IngestStreamEvidenceDto,
  'level' | 'result' | 'reason' | 'attemptId' | 'endpoint' | 'media'
>;
const NVR_ATTEMPT_LEVELS = [
  'E5_RTSP_SESSION_NEGOTIATED',
  'E6_FRAMES_RECEIVED',
];
const STREAM_ORDER: string[] = [
  'E4_STREAM_URI_OBTAINED',
  'E5_RTSP_SESSION_NEGOTIATED',
  'E6_FRAMES_RECEIVED',
];

@Injectable()
export class DeviceEvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DeviceRepository,
  ) {}

  recordStreamEvidence(
    observerDeviceId: string,
    input: IngestStreamEvidenceDto,
  ) {
    const value = validateStreamEvidence(input);
    return this.prisma.evidenceRecord.createMany({
      data: [
        {
          deviceId: value.deviceId,
          observerDeviceId,
          kind: 'OBSERVATION',
          source: value.source,
          confidence: 'OBSERVED',
          // An unsuccessful attempt is never evidence that the level was attained.
          level:
            value.result === 'SUCCEEDED'
              ? STREAM_LEDGER_LEVEL[value.level]
              : 'E0_UNKNOWN',
          subject: 'video.stream',
          observedAt: new Date(value.observedAt),
          expiresAt: new Date(value.expiresAt),
          sourceEventKey: `stream:${observerDeviceId}:${value.probeId}:${value.deviceId}:${value.level}:${value.sourceEventKey}`,
          payload: this.json(value),
        },
      ],
      skipDuplicates: true,
    });
  }

  recordDirectTelemetry(
    device: { id: string; deviceType: string },
    input: IngestDeviceTelemetryDto,
  ) {
    const observedAt = new Date(input.timestamp * 1000);
    const expiresAt = new Date(
      observedAt.getTime() + 2 * 60 * 1000,
    );

    return this.prisma.evidenceRecord.createMany({
      data: [{
        deviceId: device.id,
        kind: 'OBSERVATION',
        source: this.directSource(device.deviceType),
        confidence: 'OBSERVED',
        level: 'E1_ENDPOINT_REACHABLE',
        subject: 'device.telemetry',
        observedAt,
        expiresAt,
        sourceEventKey: `device:${device.id}:telemetry:${input.timestamp}`,
        payload: this.json({
          status: input.status ?? null,
          temperatureC: input.temperatureC ?? null,
          bitrateKbps: input.bitrateKbps ?? null,
          storageUsedPct: input.storageUsedPct ?? null,
          uptimeSeconds: input.uptimeSeconds ?? null,
          model: input.model ?? null,
          firmware: input.firmware ?? null,
          collectionState: input.collectionState ?? null,
          collectionIssues: input.collectionIssues ?? null,
          capabilities: input.capabilities ?? null,
          details: input.details ?? null,
        }),
      }],
      skipDuplicates: true,
    });
  }

  private directSource(deviceType: string): 'DEVICE' | 'ADAPTER' | 'GATEWAY' {
    if (deviceType === 'RECORDER') {
      return 'ADAPTER';
    }
    if (deviceType === 'GATEWAY') {
      return 'GATEWAY';
    }
    return 'DEVICE';
  }

  recordRecorderObservations(
    recorderDeviceId: string,
    timestamp: number,
    observations: RecorderObservedDeviceDto[],
  ) {
    const observedAt = new Date(timestamp * 1000);
    const expiresAt = new Date(observedAt.getTime() + 2 * 60 * 1000);

    return this.prisma.evidenceRecord.createMany({
      data: observations.map((observation) => ({
        deviceId: observation.deviceId,
        observerDeviceId: recorderDeviceId,
        kind: 'OBSERVATION' as const,
        source: 'RECORDER' as const,
        confidence: 'VERIFIED' as const,
        level: 'E3_PROFILE_DISCOVERED' as const,
        subject: 'recorder.channel',
        observedAt,
        expiresAt,
        sourceEventKey: `recorder:${recorderDeviceId}:${observation.deviceId}:${timestamp}`,
        payload: this.json(observation),
      })),
      skipDuplicates: true,
    });
  }

  async findByDeviceId(
    deviceId: string,
    organizationId: string,
    limit: number,
  ) {
    const device = await this.devices.findByIdWithSite(
      deviceId,
      organizationId,
    );

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    const records = await this.prisma.evidenceRecord.findMany({
      where: { deviceId },
      orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });

    const now = Date.now();
    return {
      deviceId,
      generatedAt: new Date(now).toISOString(),
      count: records.length,
      evidence: records.map((record) => ({
        ...record,
        freshness:
          record.expiresAt === null
            ? 'UNKNOWN'
            : record.expiresAt.getTime() >= now
              ? 'FRESH'
              : 'STALE',
      })),
    };
  }

  /**
   * Latest stream probe attempt for a device, read-only. States keep
   * "never measured", "expired" and "measurement failed" distinct; none of
   * them is connectivity status and none is recording proof.
   */
  async latestStreamMeasurement(deviceId: string, organizationId: string) {
    const device = await this.devices.findByIdWithSite(
      deviceId,
      organizationId,
    );
    if (!device) {
      throw new NotFoundException('Device not found');
    }
    const now = Date.now();
    const generatedAt = new Date(now).toISOString();
    const order = [
      { observedAt: 'desc' as const },
      { createdAt: 'desc' as const },
    ];
    const latest = await this.prisma.evidenceRecord.findFirst({
      where: { deviceId, subject: 'video.stream' },
      orderBy: order,
    });
    if (!latest) {
      return {
        deviceId,
        generatedAt,
        state: 'NO_MEASUREMENT',
        measurement: null,
      };
    }
    const attemptId = (latest.payload as unknown as StreamPayload).attemptId;
    const records = attemptId
      ? await this.prisma.evidenceRecord.findMany({
          where: {
            deviceId,
            subject: 'video.stream',
            observerDeviceId: latest.observerDeviceId,
            payload: { path: ['attemptId'], equals: attemptId },
          },
          orderBy: order,
          take: 3,
        })
      : [latest];
    const rows = records.map(
      (record) => record.payload as unknown as StreamPayload,
    );
    const stage = (level: string) => {
      const row = rows.find((item) => item.level === level);
      return row ? { result: row.result, reason: row.reason } : null;
    };
    // The attempt's outcome is its first stage that did not succeed.
    const outcome =
      rows
        .slice()
        .sort(
          (a, b) =>
            STREAM_ORDER.indexOf(a.level) - STREAM_ORDER.indexOf(b.level),
        )
        .find(
          (row) => row.result !== 'SUCCEEDED' && row.result !== 'NOT_OBSERVED',
        ) ?? rows[0];
    const media = rows.find((row) => row.media)?.media ?? null;
    const endpoint = rows.find((row) => row.endpoint)?.endpoint;
    const expiresAt = Math.max(
      ...records.map((record) => record.expiresAt?.getTime() ?? 0),
    );
    const observer = latest.observerDeviceId
      ? await this.prisma.device.findFirst({
          where: { id: latest.observerDeviceId, siteId: device.siteId },
          select: { id: true, name: true, deviceType: true },
        })
      : null;
    const succeeded = outcome.result === 'SUCCEEDED';
    // An NVR-mediated run always emits E5 and E6; if one has not reached the
    // ledger (partial delivery), the attempt must not read as a success.
    const complete =
      endpoint?.access !== 'NVR_MEDIATED' ||
      NVR_ATTEMPT_LEVELS.every((level) => rows.some((row) => row.level === level));
    return {
      deviceId,
      generatedAt,
      state:
        expiresAt < now
          ? 'EXPIRED'
          : !complete
            ? 'INCOMPLETE'
            : succeeded
              ? 'SUCCEEDED'
              : 'FAILED',
      measurement: {
        attemptId: attemptId ?? null,
        complete,
        observedAt: latest.observedAt.toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        freshness: expiresAt >= now ? 'FRESH' : 'STALE',
        source: latest.source,
        confidence: latest.confidence,
        observer,
        access: endpoint?.access ?? null,
        uriSource: endpoint?.discoveryMethod ?? null,
        channelNumber: endpoint?.channelNumber ?? null,
        result: outcome.result,
        reason: outcome.reason,
        negotiation: stage('E5_RTSP_SESSION_NEGOTIATED'),
        media: { ...stage('E6_FRAMES_RECEIVED'), proof: media },
        // RTP packets are not decoded frames; no recording is implied.
        decodedFrames:
          media?.measurement === 'DECODED_VIDEO_FRAMES'
            ? 'MEASURED'
            : 'NOT_MEASURED',
      },
    };
  }

  private json(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
