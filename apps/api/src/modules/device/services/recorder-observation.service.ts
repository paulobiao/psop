import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import type {
  Device,
} from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type {
  RecorderObservedDeviceDto,
} from '../dto/ingest-recorder-observations.dto.js';
import type {
  DeviceWithSite,
} from '../repositories/device.repository.js';

@Injectable()
export class RecorderObservationService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async upsertBatch(
    recorder: Device,
    timestamp: number,
    observations: RecorderObservedDeviceDto[],
  ) {
    const uniqueIds = [
      ...new Set(
        observations.map(
          (observation) => observation.deviceId,
        ),
      ),
    ];

    if (uniqueIds.length !== observations.length) {
      throw new BadRequestException(
        'Recorder observations must contain unique deviceId values',
      );
    }

    const children = await this.prisma.device.findMany({
      where: {
        id: {
          in: uniqueIds,
        },
        siteId: recorder.siteId,
        deletedAt: null,
        status: 'ACTIVE',
        deviceType: 'CAMERA',
        monitoringMode: 'VIA_GATEWAY',
        gatewayDeviceId: recorder.id,
      },
      select: {
        id: true,
      },
    });

    const allowed = new Set(
      children.map((child) => child.id),
    );

    const invalidIds = uniqueIds.filter(
      (deviceId) => !allowed.has(deviceId),
    );

    if (invalidIds.length > 0) {
      throw new BadRequestException(
        'All observed devices must be active VIA_GATEWAY children of the authenticated recorder',
      );
    }

    const observedAt = new Date(timestamp * 1000);
    const receivedAt = new Date();

    const newerSnapshot =
      await this.prisma.recorderObservationSnapshot
        .findFirst({
          where: {
            deviceId: {
              in: uniqueIds,
            },
            observedAt: {
              gt: observedAt,
            },
          },
          select: {
            deviceId: true,
            observedAt: true,
          },
        });

    if (newerSnapshot) {
      throw new BadRequestException(
        'Recorder observation batch is older than the current snapshot',
      );
    }

    await this.prisma.$transaction(
      observations.map((observation) =>
        this.prisma.recorderObservationSnapshot.upsert({
          where: {
            deviceId: observation.deviceId,
          },
          update: {
            recorderDeviceId: recorder.id,
            observedAt,
            receivedAt,
            reportedStatus: observation.status,
            channelId: observation.channelId,
            channelNumber: observation.channelNumber,
            poePort: observation.poePort,
            poePowerW: observation.poePowerW,
            recordingStatus: observation.recordingStatus,
            protocol: observation.protocol,
            bitrateKbps: observation.bitrateKbps,
            resolution: observation.resolution,
            frameRate: observation.frameRate,
            model: observation.model,
            firmware: observation.firmware,
          },
          create: {
            deviceId: observation.deviceId,
            recorderDeviceId: recorder.id,
            observedAt,
            receivedAt,
            reportedStatus: observation.status,
            channelId: observation.channelId,
            channelNumber: observation.channelNumber,
            poePort: observation.poePort,
            poePowerW: observation.poePowerW,
            recordingStatus: observation.recordingStatus,
            protocol: observation.protocol,
            bitrateKbps: observation.bitrateKbps,
            resolution: observation.resolution,
            frameRate: observation.frameRate,
            model: observation.model,
            firmware: observation.firmware,
          },
        }),
      ),
    );

    return {
      accepted: observations.length,
      observedAt: observedAt.toISOString(),
    };
  }

  async findFleetItems(
    devices: DeviceWithSite[],
  ): Promise<Record<string, unknown>[]> {
    if (devices.length === 0) {
      return [];
    }

    const snapshots =
      await this.prisma.recorderObservationSnapshot.findMany({
        where: {
          deviceId: {
            in: devices.map((device) => device.id),
          },
        },
      });

    const devicesById = new Map(
      devices.map((device) => [device.id, device]),
    );

    return snapshots.flatMap((snapshot) => {
      const device = devicesById.get(snapshot.deviceId);

      return (
        device &&
        device.gatewayDeviceId ===
          snapshot.recorderDeviceId
      )
        ? [this.toTelemetryItem(snapshot, device)]
        : [];
    });
  }

  async findItem(
    device: DeviceWithSite,
  ): Promise<Record<string, unknown> | undefined> {
    const snapshot =
      await this.prisma.recorderObservationSnapshot.findUnique({
        where: {
          deviceId: device.id,
        },
      });

    return (
      snapshot &&
      device.gatewayDeviceId ===
        snapshot.recorderDeviceId
    )
      ? this.toTelemetryItem(snapshot, device)
      : undefined;
  }

  private toTelemetryItem(
    snapshot: {
      deviceId: string;
      recorderDeviceId: string;
      observedAt: Date;
      reportedStatus: string;
      channelId: string | null;
      channelNumber: number | null;
      poePort: number | null;
      poePowerW: number | null;
      recordingStatus: string | null;
      protocol: string | null;
      bitrateKbps: number | null;
      resolution: string | null;
      frameRate: number | null;
      model: string | null;
      firmware: string | null;
    },
    device: DeviceWithSite,
  ) {
    return {
      camera_id: device.id,
      site_id: device.siteId,
      external_id: device.externalId,
      timestamp: Math.floor(
        snapshot.observedAt.getTime() / 1000,
      ),
      iso_time: snapshot.observedAt.toISOString(),
      status: snapshot.reportedStatus,
      bitrate_kbps: snapshot.bitrateKbps,
      model: snapshot.model ?? device.model,
      firmware:
        snapshot.firmware ?? device.firmwareVersion,
      observation_source: 'RECORDER',
      individual_verification: 'RECORDER_VERIFIED',
      observer_device_id: snapshot.recorderDeviceId,
      channel_id: snapshot.channelId,
      channel_number: snapshot.channelNumber,
      poe_port: snapshot.poePort,
      poe_power_w: snapshot.poePowerW,
      recording_status: snapshot.recordingStatus,
      protocol: snapshot.protocol,
      resolution: snapshot.resolution,
      frame_rate: snapshot.frameRate,
    };
  }
}
