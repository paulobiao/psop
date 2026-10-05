import {
  Activity,
  AlertTriangle,
  Camera,
  Clock3,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Network,
  RefreshCw,
  Thermometer,
  Wifi,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getDevice,
  getDeviceAlerts,
  getOperationsOverview,
  evaluateFleetConnectivity,
  getDeviceConnectivityEvents,
  getDeviceStreamMeasurement,
  getDeviceTelemetry,
  getTelemetryDemoStatus,
  setDeviceDemoState,
} from "./api";
import DeviceIngestionPanel from "./DeviceIngestionPanel";
import type {
  ConnectivityEvent,
  ConnectivityState,
  DeviceAlert,
  DeviceStreamMeasurement,
  FleetDevice,
  GatewayManagedDevice,
  InventoryDevice,
  TelemetryDemoState,
} from "./types";

interface DeviceDetailsPanelProps {
  deviceId: string;
  onClose: () => void;
  onChanged?: () => void;
}

function telemetryDetail(
  value: Record<string, unknown> | null | undefined,
  key: string,
): unknown {
  return value?.[key];
}

function detailNumber(
  value: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const item = telemetryDetail(value, key);
  return typeof item === "number" && Number.isFinite(item)
    ? item
    : null;
}

function detailString(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const item = telemetryDetail(value, key);
  return typeof item === "string" && item.trim()
    ? item
    : null;
}

function formatDate(value: string | null): string {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return "No heartbeat";
  }

  if (seconds < 60) {
    return `${seconds} seconds`;
  }

  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);

    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);

    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }

  const days = Math.floor(seconds / 86400);

  return `${days} ${days === 1 ? "day" : "days"}`;
}

function stateLabel(state: ConnectivityState): string {
  const labels: Record<ConnectivityState, string> = {
    ONLINE: "Online",
    DEGRADED: "Degraded",
    OFFLINE: "Offline",
    NEVER_SEEN: "Never seen",
    UNKNOWN: "Unknown",
  };

  return labels[state];
}

const STREAM_STATE: Record<
  DeviceStreamMeasurement["state"] | "UNAVAILABLE",
  { label: string; badge: string; note: string }
> = {
  NO_MEASUREMENT: {
    label: "No measurement",
    badge: "never_seen",
    note: "No stream probe has reported for this camera.",
  },
  SUCCEEDED: {
    label: "Media observed",
    badge: "online",
    note: "Session negotiated and video RTP packets received.",
  },
  FAILED: {
    label: "Measurement failed",
    badge: "offline",
    note: "The latest probe attempt did not complete.",
  },
  INCOMPLETE: {
    label: "Partial delivery",
    badge: "degraded",
    note: "Only part of the latest attempt reached PSOP; the rest is pending or was rejected.",
  },
  EXPIRED: {
    label: "Evidence expired",
    badge: "degraded",
    note: "The latest result is past its validity; it is not current.",
  },
  UNAVAILABLE: {
    label: "Unavailable",
    badge: "unknown",
    note: "Stream measurement could not be loaded.",
  },
};

function enumLabel(value: string | null | undefined): string {
  return value ? value.toLowerCase().replaceAll("_", " ") : "—";
}

function StreamMeasurementSection({
  value,
}: {
  value: DeviceStreamMeasurement | null;
}) {
  const state = STREAM_STATE[value?.state ?? "UNAVAILABLE"];
  const m = value?.measurement ?? null;
  const proof = m?.media.proof ?? null;

  return (
    <section className="details-section">
      <div className="details-section__heading">
        <div>
          <span className="eyebrow">Video assurance · separate from connectivity</span>
          <h3>Stream measurement</h3>
        </div>
        <span className={`badge badge--${state.badge}`}>{state.label}</span>
      </div>

      <p className="details-section__note">
        {state.note}
        {m && !m.complete && value?.state !== "INCOMPLETE"
          ? " This attempt was only partially delivered."
          : ""}
      </p>

      {m && (
        <div className="detail-metrics">
          <DetailMetric
            label="Result"
            value={
              // Overall result needs the whole attempt; stages below keep their own outcome.
              !m.complete
                ? "Incomplete · partially delivered"
                : m.result === "SUCCEEDED"
                  ? "Succeeded"
                  : `${enumLabel(m.result)} · ${enumLabel(m.reason)}`
            }
            icon={<Activity size={19} />}
          />
          <DetailMetric
            label="Negotiation (DESCRIBE/SETUP/PLAY)"
            value={
              m.negotiation
                ? `${enumLabel(m.negotiation.result)}${m.negotiation.reason === "NONE" ? "" : ` · ${enumLabel(m.negotiation.reason)}`}`
                : "Not reported"
            }
            icon={<Network size={19} />}
          />
          <DetailMetric
            label={
              proof?.measurement === "DECODED_VIDEO_FRAMES"
                ? "Decoded video frames"
                : "Video RTP packets (not decoded frames)"
            }
            value={
              proof
                ? `${proof.count.toLocaleString()} in ${(proof.windowMs / 1000).toFixed(1)} s`
                : m.media.result
                  ? `${enumLabel(m.media.result)} · ${enumLabel(m.media.reason)}`
                  : "Not reported"
            }
            icon={<Camera size={19} />}
          />
          <DetailMetric
            label="Origin"
            value={
              m.access === "NVR_MEDIATED"
                ? `Via recorder ${m.observer?.name ?? ""}${m.channelNumber ? ` · channel ${m.channelNumber}` : ""}`.trim()
                : `${enumLabel(m.source)}${m.observer ? ` · ${m.observer.name}` : ""}`
            }
            icon={<HardDrive size={19} />}
          />
          <DetailMetric
            label="URI source"
            value={
              m.uriSource === "MANUAL_OPERATOR_INPUT"
                ? "Operator-supplied (no discovery)"
                : enumLabel(m.uriSource)
            }
            icon={<Database size={19} />}
          />
          <DetailMetric
            label="Measured"
            value={formatDate(m.observedAt)}
            icon={<Clock3 size={19} />}
          />
          <DetailMetric
            label={m.freshness === "FRESH" ? "Valid until" : "Expired at"}
            value={formatDate(m.expiresAt)}
            icon={<Clock3 size={19} />}
          />
        </div>
      )}

      {m && (
        <small className="details-section__note">
          Probe attestation ({enumLabel(m.confidence)}). Does not prove
          decoded images, recording or retrieval.
        </small>
      )}
    </section>
  );
}

function DetailMetric({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <article className="detail-metric">
      <span className="detail-metric__icon">{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </article>
  );
}

function EventEntry({ event }: { event: ConnectivityEvent }) {
  return (
    <article className="details-event">
      <span
        className={`details-event__dot details-event__dot--${event.current_state.toLowerCase()}`}
      />

      <div>
        <div className="details-event__heading">
          <strong>
            {event.previous_state
              ? `${stateLabel(event.previous_state)} → ${stateLabel(
                  event.current_state,
                )}`
              : `Initial state: ${stateLabel(event.current_state)}`}
          </strong>

          <span className={`badge badge--${event.current_state.toLowerCase()}`}>
            {stateLabel(event.current_state)}
          </span>
        </div>

        <small>{formatDate(event.detected_at)}</small>
      </div>
    </article>
  );
}

function alertDuration(alert: DeviceAlert): string {
  const startedAt = new Date(
    alert.openedAt,
  ).getTime();

  const endedAt = alert.resolvedAt
    ? new Date(alert.resolvedAt).getTime()
    : Date.now();

  const seconds = Math.max(
    0,
    Math.floor(
      (endedAt - startedAt) / 1000,
    ),
  );

  return formatDuration(seconds);
}

function AlertEntry({ alert }: { alert: DeviceAlert }) {
  return (
    <article className="details-alert">
      <div
        className={`details-alert__icon details-alert__icon--${alert.severity.toLowerCase()}`}
      >
        <AlertTriangle size={17} />
      </div>

      <div>
        <div className="details-alert__heading">
          <strong>{alert.title}</strong>
          <span
            className={`severity severity--${alert.severity.toLowerCase()}`}
          >
            {alert.status}
          </span>
        </div>

        <p>{alert.message}</p>

        <small>
          Opened {formatDate(alert.openedAt)}
          {alert.resolvedAt
            ? ` · Resolved ${formatDate(alert.resolvedAt)}`
            : ""}
          {` · Duration ${alertDuration(alert)}`}
        </small>
      </div>
    </article>
  );
}

export default function DeviceDetailsPanel({
  deviceId,
  onClose,
  onChanged,
}: DeviceDetailsPanelProps) {
  const [telemetry, setTelemetry] = useState<FleetDevice | null>(null);
  const [inventoryDevice, setInventoryDevice] =
    useState<InventoryDevice | null>(null);
  const [
    derivedGatewayStatus,
    setDerivedGatewayStatus,
  ] = useState<GatewayManagedDevice | null>(
    null,
  );
  const [streamMeasurement, setStreamMeasurement] =
    useState<DeviceStreamMeasurement | null>(null);
  const [events, setEvents] = useState<ConnectivityEvent[]>([]);
  const [alerts, setAlerts] = useState<DeviceAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demoEnabled, setDemoEnabled] = useState(false);
  const [demoChanging, setDemoChanging] = useState<TelemetryDemoState | null>(
    null,
  );

  const loadDetails = useCallback(
    async (silent = false) => {
      const controller = new AbortController();

      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        const deviceResult = await getDevice(
          deviceId,
          controller.signal,
        );

        setInventoryDevice(deviceResult);
        setTelemetry(null);
        setDerivedGatewayStatus(null);
        setEvents([]);
        setAlerts([]);
        setStreamMeasurement(null);
        setDemoEnabled(false);

        const supportsTelemetry =
          deviceResult.monitoringMode !==
            'INVENTORY_ONLY' &&
          [
            'CAMERA',
            'RECORDER',
            'GATEWAY',
          ].includes(deviceResult.deviceType);

        if (!supportsTelemetry) {
          const alertsResult =
            await getDeviceAlerts(
              deviceId,
              controller.signal,
            );

          setAlerts(alertsResult);
          setError(null);
        } else {
          const [
            telemetryResult,
            eventsResult,
            alertsResult,
            demoStatus,
            overviewResult,
            streamResult,
          ] = await Promise.all([
            getDeviceTelemetry(
              deviceId,
              controller.signal,
            ),
            getDeviceConnectivityEvents(
              deviceId,
              controller.signal,
            ),
            getDeviceAlerts(
              deviceId,
              controller.signal,
            ),
            getTelemetryDemoStatus(
              controller.signal,
            ),
            getOperationsOverview(
              controller.signal,
            ),
            // Optional evidence: its failure must not hide the device panel.
            deviceResult.deviceType === "CAMERA"
              ? getDeviceStreamMeasurement(
                  deviceId,
                  controller.signal,
                ).catch(() => null)
              : Promise.resolve(null),
          ]);

          setStreamMeasurement(streamResult);

          setTelemetry(telemetryResult);
          setDemoEnabled(demoStatus.enabled);
          setEvents(eventsResult.events);
          setAlerts(alertsResult);
          setDerivedGatewayStatus(
            deviceResult.monitoringMode ===
              'VIA_GATEWAY'
              ? overviewResult.gatewayManaged.find(
                  (item) =>
                    item.device.id === deviceId,
                ) ?? null
              : null,
          );
          setError(null);
        }
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to load device details",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }

      return () => controller.abort();
    },
    [deviceId],
  );

  useEffect(() => {
    void loadDetails();
  }, [loadDetails]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const activeAlerts = useMemo(
    () => alerts.filter((alert) => alert.status === "OPEN"),
    [alerts],
  );

  async function applyDemoState(state: TelemetryDemoState) {
    setDemoChanging(state);
    setError(null);

    try {
      await setDeviceDemoState(deviceId, state);

      await evaluateFleetConnectivity();
      await loadDetails(true);
      onChanged?.();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to apply demo state",
      );
    } finally {
      setDemoChanging(null);
    }
  }

  return (
    <div
      className="details-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <aside
        className="device-details"
        role="dialog"
        aria-modal="true"
        aria-label="Device details"
      >
        <header className="device-details__header">
          <div>
            <span className="eyebrow">Device intelligence</span>
            <h2>
              {telemetry?.device.name ??
                inventoryDevice?.name ??
                "Device details"}
            </h2>

            {(telemetry || inventoryDevice) && (
              <p>
                {telemetry?.device.siteName ??
                  "Registered equipment"}{" "}
                ·{" "}
                {telemetry?.device.externalId ??
                  inventoryDevice?.externalId}
              </p>
            )}
          </div>

          <div className="device-details__actions">
            <button
              type="button"
              className="icon-button"
              onClick={() => void loadDetails(true)}
              disabled={refreshing}
              aria-label="Refresh device details"
            >
              <RefreshCw
                size={18}
                className={refreshing ? "spin" : undefined}
              />
            </button>

            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label="Close device details"
            >
              <X size={20} />
            </button>
          </div>
        </header>

        {loading && !inventoryDevice && (
          <div className="details-loading">
            <RefreshCw className="spin" size={25} />
            <strong>Loading device details…</strong>
          </div>
        )}

        {error && (
          <div className="error-banner details-error">
            <AlertTriangle size={18} />
            <span>{error}</span>
          </div>
        )}

        {inventoryDevice && (
          <div className="device-details__body">
            {inventoryDevice?.monitoringMode ===
              'VIA_GATEWAY' && (
              <section className="monitoring-notice">
                <strong>
                  {telemetry?.monitoring
                    .individualVerification ===
                  'RECORDER_VERIFIED'
                    ? 'Recorder-verified telemetry'
                    : 'Monitored through another device'}
                </strong>
                <span>
                  {telemetry?.monitoring
                    .individualVerification ===
                  'RECORDER_VERIFIED'
                    ? `Individual device status is verified by ${
                        derivedGatewayStatus?.gateway.name ??
                        'the assigned recorder'
                      }.`
                    : 'Individual device status is not independently verified by the current monitoring source.'}
                </span>
              </section>
            )}

            {derivedGatewayStatus &&
              telemetry?.monitoring
                .individualVerification !==
                'RECORDER_VERIFIED' && (
              <section className="gateway-derived-card">
                <div className="gateway-derived-card__icon">
                  <Network size={21} />
                </div>

                <div className="gateway-derived-card__content">
                  <span className="eyebrow">
                    Gateway-derived visibility
                  </span>
                  <h3>
                    {derivedGatewayStatus.gateway.name}
                  </h3>
                  <p>
                    The monitoring gateway is{' '}
                    <strong>
                      {stateLabel(
                        derivedGatewayStatus.gateway
                          .connectivity.state,
                      )}
                    </strong>
                    . Its last heartbeat was{' '}
                    {formatDate(
                      derivedGatewayStatus.gateway
                        .connectivity.lastHeartbeatAt,
                    )}
                    .
                  </p>
                  <small>
                    Individual camera stream, recording and
                    device health are not verified by this
                    gateway heartbeat.
                  </small>
                </div>

                <span
                  className={`badge badge--${derivedGatewayStatus.gateway.connectivity.state.toLowerCase()}`}
                >
                  Gateway{' '}
                  {stateLabel(
                    derivedGatewayStatus.gateway
                      .connectivity.state,
                  )}
                </span>
              </section>
            )}

            {inventoryDevice?.monitoringMode ===
              'INVENTORY_ONLY' && (
              <section className="monitoring-notice">
                <strong>Inventory-only asset</strong>
                <span>
                  This equipment is registered but does
                  not currently send telemetry.
                </span>
              </section>
            )}

            {demoEnabled &&
              inventoryDevice?.monitoringMode ===
                'DIRECT' && (
              <section className="demo-lab">
                <div>
                  <span className="eyebrow">Local simulation</span>
                  <h3>Telemetry Demo Lab</h3>
                  <p>
                    Apply a controlled camera state without calling AWS
                    services.
                  </p>
                </div>

                <div className="demo-lab__actions">
                  {(
                    [
                      "ONLINE",
                      "DEGRADED",
                      "OFFLINE",
                      "NEVER_SEEN",
                      "UNKNOWN",
                    ] as TelemetryDemoState[]
                  ).map((state) => (
                    <button
                      key={state}
                      type="button"
                      className={`demo-state-button demo-state-button--${state.toLowerCase()}`}
                      disabled={demoChanging !== null}
                      onClick={() => void applyDemoState(state)}
                    >
                      {demoChanging === state
                        ? "Applying…"
                        : state.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {inventoryDevice?.monitoringMode ===
              'DIRECT' &&
              ['CAMERA', 'RECORDER', 'GATEWAY'].includes(
                inventoryDevice.deviceType,
              ) && (
                <DeviceIngestionPanel
                  deviceId={deviceId}
                />
              )}

            {telemetry && (
            <section className="connection-hero">
              <div
                className={`connection-hero__icon connection-hero__icon--${telemetry.connectivity.state.toLowerCase()}`}
              >
                <Wifi size={25} />
              </div>

              <div>
                <span>Connectivity</span>
                <strong>{stateLabel(telemetry.connectivity.state)}</strong>
                <small>
                  Last heartbeat{" "}
                  {formatDate(telemetry.connectivity.lastHeartbeatAt)}
                </small>

                {telemetry.connectivity.reasons.length > 0 && (
                  <small className="health-reasons">
                    {telemetry.connectivity.reasons
                      .map((reason) =>
                        reason.toLowerCase().replaceAll("_", " "),
                      )
                      .join(" · ")}
                  </small>
                )}
              </div>

              <span
                className={`badge badge--${telemetry.connectivity.state.toLowerCase()}`}
              >
                {stateLabel(telemetry.connectivity.state)}
              </span>
            </section>
            )}

            {telemetry &&
              inventoryDevice.deviceType === "CAMERA" && (
                <StreamMeasurementSection value={streamMeasurement} />
              )}

            {telemetry && (
            <section className="details-section">
              <div className="details-section__heading">
                <div>
                  <span className="eyebrow">Live telemetry</span>
                  <h3>Device health</h3>
                </div>
                <Gauge size={19} />
              </div>

              <div className="detail-metrics">
                {inventoryDevice?.deviceType ===
                "RECORDER" ? (
                  <>
                    <DetailMetric
                      label="Storage"
                      value={
                        detailString(
                          telemetry.telemetry?.details,
                          "storageState",
                        ) === "NOT_INSTALLED"
                          ? "No HDD installed"
                          : detailString(
                              telemetry.telemetry?.details,
                              "storageState",
                            ) ?? "Not reported"
                      }
                      icon={<HardDrive size={19} />}
                    />

                    <DetailMetric
                      label="Channels online"
                      value={
                        (() => {
                          const online = detailNumber(
                            telemetry.telemetry?.details,
                            "onlineChannelCount",
                          );
                          const observed = detailNumber(
                            telemetry.telemetry?.details,
                            "observedChannelCount",
                          );
                          return online === null
                            ? "Not reported"
                            : observed === null
                              ? `${online}`
                              : `${online} / ${observed}`;
                        })()
                      }
                      icon={<Camera size={19} />}
                    />

                    <DetailMetric
                      label="PoE power budget"
                      value={
                        (() => {
                          const total = detailNumber(
                            telemetry.telemetry?.details,
                            "poeTotalPowerW",
                          );
                          const used = detailNumber(
                            telemetry.telemetry?.details,
                            "poeUsedPowerW",
                          );
                          return total === null
                            ? "Not reported"
                            : used === null
                              ? `${total.toFixed(2)} W total`
                              : `${used.toFixed(2)} / ${total.toFixed(2)} W`;
                        })()
                      }
                      icon={<Activity size={19} />}
                    />

                    <DetailMetric
                      label="PoE remaining"
                      value={
                        (() => {
                          const value = detailNumber(
                            telemetry.telemetry?.details,
                            "poeRemainingPowerW",
                          );
                          return value === null
                            ? "Not reported"
                            : `${value.toFixed(2)} W`;
                        })()
                      }
                      icon={<Activity size={19} />}
                    />

                    <DetailMetric
                      label="Firmware"
                      value={
                        telemetry.telemetry?.firmware ||
                        "Not reported"
                      }
                      icon={<Cpu size={19} />}
                    />

                    <DetailMetric
                      label="Model"
                      value={
                        telemetry.telemetry?.model ||
                        "Not reported"
                      }
                      icon={<Camera size={19} />}
                    />

                    <DetailMetric
                      label="Hardware"
                      value={
                        detailString(
                          telemetry.telemetry?.details,
                          "hardwareVersion",
                        ) ?? "Not reported"
                      }
                      icon={<Cpu size={19} />}
                    />

                    <DetailMetric
                      label="API version"
                      value={
                        detailString(
                          telemetry.telemetry?.details,
                          "apiVersion",
                        ) ?? "Not reported"
                      }
                      icon={<Network size={19} />}
                    />

                    <DetailMetric
                      label="ONVIF version"
                      value={
                        detailString(
                          telemetry.telemetry?.details,
                          "onvifVersion",
                        ) ?? "Not reported"
                      }
                      icon={<Network size={19} />}
                    />

                    <DetailMetric
                      label="Verification"
                      value="Direct"
                      icon={<Wifi size={19} />}
                    />

                    <DetailMetric
                      label="Heartbeat age"
                      value={formatDuration(
                        telemetry.connectivity.ageSeconds,
                      )}
                      icon={<Clock3 size={19} />}
                    />

                    <DetailMetric
                      label="Disks"
                      value={
                        (() => {
                          const count = detailNumber(
                            telemetry.telemetry?.details,
                            "diskCount",
                          );
                          return count === null
                            ? "Not reported"
                            : `${count}`;
                        })()
                      }
                      icon={<HardDrive size={19} />}
                    />
                  </>
                ) : (
                  <>
                <DetailMetric
                  label="Temperature"
                  value={
                    telemetry.telemetry?.temperatureC === null ||
                    telemetry.telemetry?.temperatureC === undefined
                      ? "Not reported"
                      : `${telemetry.telemetry.temperatureC.toFixed(1)}°C`
                  }
                  icon={<Thermometer size={19} />}
                />

                <DetailMetric
                  label="Storage / recording"
                  value={
                    telemetry.telemetry?.recordingStatus ===
                    "NOT_AVAILABLE_NO_STORAGE"
                      ? "Recording unavailable — recorder has no HDD"
                      : telemetry.telemetry?.storageUsedPct === null ||
                          telemetry.telemetry?.storageUsedPct === undefined
                        ? telemetry.telemetry?.recordingStatus
                            ?.toLowerCase()
                            .replaceAll("_", " ") ??
                          "Not reported"
                        : `${telemetry.telemetry.storageUsedPct.toFixed(1)}%`
                  }
                  icon={<HardDrive size={19} />}
                />

                <DetailMetric
                  label="Bitrate"
                  value={
                    telemetry.telemetry?.bitrateKbps === null ||
                    telemetry.telemetry?.bitrateKbps === undefined
                      ? "Not reported"
                      : `${telemetry.telemetry.bitrateKbps} kbps`
                  }
                  icon={<Activity size={19} />}
                />

                <DetailMetric
                  label="Heartbeat age"
                  value={formatDuration(telemetry.connectivity.ageSeconds)}
                  icon={<Clock3 size={19} />}
                />

                <DetailMetric
                  label="Firmware"
                  value={telemetry.telemetry?.firmware || "Not reported"}
                  icon={<Cpu size={19} />}
                />

                <DetailMetric
                  label="Model"
                  value={telemetry.telemetry?.model || "Not reported"}
                  icon={<Camera size={19} />}
                />

                <DetailMetric
                  label="Channel"
                  value={
                    telemetry.telemetry?.channelNumber === null ||
                    telemetry.telemetry?.channelNumber === undefined
                      ? "Not applicable"
                      : `Channel ${telemetry.telemetry.channelNumber}`
                  }
                  icon={<Camera size={19} />}
                />

                <DetailMetric
                  label="PoE"
                  value={
                    telemetry.telemetry?.poePowerW === null ||
                    telemetry.telemetry?.poePowerW === undefined
                      ? "Not reported"
                      : `Port ${
                          telemetry.telemetry.poePort ?? "?"
                        } · ${telemetry.telemetry.poePowerW.toFixed(2)} W`
                  }
                  icon={<Activity size={19} />}
                />

                <DetailMetric
                  label="Protocol"
                  value={telemetry.telemetry?.protocol || "Not reported"}
                  icon={<Network size={19} />}
                />

                <DetailMetric
                  label="Verification"
                  value={
                    telemetry.monitoring.individualVerification ===
                    "RECORDER_VERIFIED"
                      ? `Recorder verified${
                          derivedGatewayStatus?.gateway.name
                            ? ` · ${derivedGatewayStatus.gateway.name}`
                            : ""
                        }`
                      : telemetry.monitoring.individualVerification ===
                          "DIRECT"
                        ? "Direct"
                        : "Not individually verified"
                  }
                  icon={<Wifi size={19} />}
                />

                <DetailMetric
                  label="Resolution"
                  value={telemetry.telemetry?.resolution || "Not reported"}
                  icon={<Gauge size={19} />}
                />

                <DetailMetric
                  label="Frame rate"
                  value={
                    telemetry.telemetry?.frameRate === null ||
                    telemetry.telemetry?.frameRate === undefined
                      ? "Not reported"
                      : `${telemetry.telemetry.frameRate} fps`
                  }
                  icon={<Activity size={19} />}
                />
                  </>
                )}
              </div>
            </section>
            )}

            <section className="details-section">
              <div className="details-section__heading">
                <div>
                  <span className="eyebrow">Incident history</span>
                  <h3>Alerts</h3>
                </div>

                <span className="panel__count">
                  {activeAlerts.length} active
                </span>
              </div>

              <div className="details-list">
                {alerts.slice(0, 10).map((alert) => (
                  <AlertEntry key={alert.id} alert={alert} />
                ))}

                {alerts.length === 0 && (
                  <div className="details-empty">
                    <Database size={23} />
                    <strong>No alert history</strong>
                    <span>Alerts for this device will appear here.</span>
                  </div>
                )}
              </div>
            </section>

            <section className="details-section">
              <div className="details-section__heading">
                <div>
                  <span className="eyebrow">Connectivity timeline</span>
                  <h3>Recent state changes</h3>
                </div>

                <span className="panel__count">{events.length} events</span>
              </div>

              <div className="details-list">
                {events.slice(0, 20).map((event) => (
                  <EventEntry
                    key={`${event.camera_id}-${event.timestamp}`}
                    event={event}
                  />
                ))}

                {events.length === 0 && (
                  <div className="details-empty">
                    <Clock3 size={23} />
                    <strong>No connectivity events</strong>
                    <span>State changes will appear here.</span>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
