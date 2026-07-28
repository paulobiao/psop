import {
  Activity,
  AlertTriangle,
  Camera,
  Clock3,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  RefreshCw,
  Thermometer,
  Wifi,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  getDeviceAlerts,
  getDeviceConnectivityEvents,
  getDeviceTelemetry,
} from './api';
import type {
  ConnectivityEvent,
  ConnectivityState,
  DeviceAlert,
  FleetDevice,
} from './types';

interface DeviceDetailsPanelProps {
  deviceId: string;
  onClose: () => void;
}

function formatDate(value: string | null): string {
  if (!value) {
    return 'Never';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return 'No heartbeat';
  }

  if (seconds < 60) {
    return `${seconds} seconds`;
  }

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} minutes`;
  }

  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)} hours`;
  }

  return `${Math.floor(seconds / 86400)} days`;
}

function stateLabel(state: ConnectivityState): string {
  const labels: Record<ConnectivityState, string> = {
    ONLINE: 'Online',
    DEGRADED: 'Degraded',
    OFFLINE: 'Offline',
    NEVER_SEEN: 'Never seen',
    UNKNOWN: 'Unknown',
  };

  return labels[state];
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

function EventEntry({
  event,
}: {
  event: ConnectivityEvent;
}) {
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
              : `Initial state: ${stateLabel(
                  event.current_state,
                )}`}
          </strong>

          <span
            className={`badge badge--${event.current_state.toLowerCase()}`}
          >
            {stateLabel(event.current_state)}
          </span>
        </div>

        <small>{formatDate(event.detected_at)}</small>
      </div>
    </article>
  );
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
            : ''}
        </small>
      </div>
    </article>
  );
}

export default function DeviceDetailsPanel({
  deviceId,
  onClose,
}: DeviceDetailsPanelProps) {
  const [telemetry, setTelemetry] =
    useState<FleetDevice | null>(null);
  const [events, setEvents] = useState<
    ConnectivityEvent[]
  >([]);
  const [alerts, setAlerts] = useState<DeviceAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDetails = useCallback(
    async (silent = false) => {
      const controller = new AbortController();

      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        const [
          telemetryResult,
          eventsResult,
          alertsResult,
        ] = await Promise.all([
          getDeviceTelemetry(
            deviceId,
            controller.signal,
          ),
          getDeviceConnectivityEvents(
            deviceId,
            controller.signal,
          ),
          getDeviceAlerts(deviceId, controller.signal),
        ]);

        setTelemetry(telemetryResult);
        setEvents(eventsResult.events);
        setAlerts(alertsResult);
        setError(null);
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : 'Unable to load device details',
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
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () =>
      window.removeEventListener(
        'keydown',
        handleKeyDown,
      );
  }, [onClose]);

  const activeAlerts = useMemo(
    () => alerts.filter((alert) => alert.status === 'OPEN'),
    [alerts],
  );

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
        aria-label="Camera details"
      >
        <header className="device-details__header">
          <div>
            <span className="eyebrow">
              Camera intelligence
            </span>
            <h2>
              {telemetry?.device.name ??
                'Device details'}
            </h2>

            {telemetry && (
              <p>
                {telemetry.device.siteName} ·{' '}
                {telemetry.device.externalId}
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
                className={refreshing ? 'spin' : undefined}
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

        {loading && !telemetry && (
          <div className="details-loading">
            <RefreshCw className="spin" size={25} />
            <strong>Loading camera details…</strong>
          </div>
        )}

        {error && (
          <div className="error-banner details-error">
            <AlertTriangle size={18} />
            <span>{error}</span>
          </div>
        )}

        {telemetry && (
          <div className="device-details__body">
            <section className="connection-hero">
              <div
                className={`connection-hero__icon connection-hero__icon--${telemetry.connectivity.state.toLowerCase()}`}
              >
                <Wifi size={25} />
              </div>

              <div>
                <span>Connectivity</span>
                <strong>
                  {stateLabel(
                    telemetry.connectivity.state,
                  )}
                </strong>
                <small>
                  Last heartbeat{' '}
                  {formatDate(
                    telemetry.connectivity
                      .lastHeartbeatAt,
                  )}
                </small>

                {telemetry.connectivity.reasons.length > 0 && (
                  <small className="health-reasons">
                    {telemetry.connectivity.reasons
                      .map((reason) =>
                        reason
                          .toLowerCase()
                          .replaceAll('_', ' '),
                      )
                      .join(' · ')}
                  </small>
                )}
              </div>

              <span
                className={`badge badge--${telemetry.connectivity.state.toLowerCase()}`}
              >
                {stateLabel(
                  telemetry.connectivity.state,
                )}
              </span>
            </section>

            <section className="details-section">
              <div className="details-section__heading">
                <div>
                  <span className="eyebrow">
                    Live telemetry
                  </span>
                  <h3>Camera health</h3>
                </div>
                <Gauge size={19} />
              </div>

              <div className="detail-metrics">
                <DetailMetric
                  label="Temperature"
                  value={
                    telemetry.telemetry?.temperatureC ===
                      null ||
                    telemetry.telemetry?.temperatureC ===
                      undefined
                      ? '—'
                      : `${telemetry.telemetry.temperatureC.toFixed(
                          1,
                        )}°C`
                  }
                  icon={<Thermometer size={19} />}
                />

                <DetailMetric
                  label="Storage used"
                  value={
                    telemetry.telemetry?.storageUsedPct ===
                      null ||
                    telemetry.telemetry?.storageUsedPct ===
                      undefined
                      ? '—'
                      : `${telemetry.telemetry.storageUsedPct.toFixed(
                          1,
                        )}%`
                  }
                  icon={<HardDrive size={19} />}
                />

                <DetailMetric
                  label="Bitrate"
                  value={
                    telemetry.telemetry?.bitrateKbps ===
                      null ||
                    telemetry.telemetry?.bitrateKbps ===
                      undefined
                      ? '—'
                      : `${telemetry.telemetry.bitrateKbps} kbps`
                  }
                  icon={<Activity size={19} />}
                />

                <DetailMetric
                  label="Heartbeat age"
                  value={formatDuration(
                    telemetry.connectivity.ageSeconds,
                  )}
                  icon={<Clock3 size={19} />}
                />

                <DetailMetric
                  label="Firmware"
                  value={
                    telemetry.telemetry?.firmware ?? '—'
                  }
                  icon={<Cpu size={19} />}
                />

                <DetailMetric
                  label="Model"
                  value={
                    telemetry.telemetry?.model ?? '—'
                  }
                  icon={<Camera size={19} />}
                />
              </div>
            </section>

            <section className="details-section">
              <div className="details-section__heading">
                <div>
                  <span className="eyebrow">
                    Incident history
                  </span>
                  <h3>Alerts</h3>
                </div>

                <span className="panel__count">
                  {activeAlerts.length} active
                </span>
              </div>

              <div className="details-list">
                {alerts.slice(0, 10).map((alert) => (
                  <AlertEntry
                    key={alert.id}
                    alert={alert}
                  />
                ))}

                {alerts.length === 0 && (
                  <div className="details-empty">
                    <Database size={23} />
                    <strong>No alert history</strong>
                    <span>
                      Alerts for this camera will appear
                      here.
                    </span>
                  </div>
                )}
              </div>
            </section>

            <section className="details-section">
              <div className="details-section__heading">
                <div>
                  <span className="eyebrow">
                    Connectivity timeline
                  </span>
                  <h3>Recent state changes</h3>
                </div>

                <span className="panel__count">
                  {events.length} events
                </span>
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
                    <span>
                      State changes will appear here.
                    </span>
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
