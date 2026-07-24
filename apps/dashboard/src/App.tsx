import {
  Activity,
  AlertTriangle,
  Building2,
  Boxes,
  Camera,
  CheckCircle2,
  Clock3,
  Database,
  Radio,
  RefreshCw,
  Server,
  ShieldAlert,
  WifiOff,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { getOperationsOverview } from './api';
import DeviceDetailsPanel from './DeviceDetailsPanel';
import InventoryPanel from './InventoryPanel';
import type {
  ActiveAlert,
  ConnectivityEvent,
  ConnectivityState,
  FleetDevice,
  OperationsOverview,
} from './types';

const REFRESH_INTERVAL_MS = 15_000;

function formatDate(value: string | null): string {
  if (!value) {
    return 'Never';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function formatAge(seconds: number | null): string {
  if (seconds === null) {
    return 'No heartbeat';
  }

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }

  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }

  return `${Math.floor(seconds / 86400)}d ago`;
}

function stateLabel(state: ConnectivityState): string {
  const labels: Record<ConnectivityState, string> = {
    ONLINE: 'Online',
    OFFLINE: 'Offline',
    NEVER_SEEN: 'Never seen',
    UNKNOWN: 'Unknown',
  };

  return labels[state];
}

function StateBadge({
  state,
}: {
  state: ConnectivityState;
}) {
  return (
    <span
      className={`badge badge--${state.toLowerCase()}`}
    >
      <span className="badge__dot" />
      {stateLabel(state)}
    </span>
  );
}

function SummaryCard({
  label,
  value,
  caption,
  icon,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  caption: string;
  icon: React.ReactNode;
  tone?: 'neutral' | 'positive' | 'danger' | 'warning';
}) {
  return (
    <article className={`summary-card summary-card--${tone}`}>
      <div className="summary-card__header">
        <span>{label}</span>
        <span className="summary-card__icon">{icon}</span>
      </div>
      <strong>{value}</strong>
      <small>{caption}</small>
    </article>
  );
}

function FleetRow({
  item,
  onSelect,
}: {
  item: FleetDevice;
  onSelect: () => void;
}) {
  const temperature = item.telemetry?.temperatureC;
  const storage = item.telemetry?.storageUsedPct;

  return (
    <tr
      className="fleet-row"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <td>
        <div className="device-name">
          <span className="device-name__icon">
            <Camera size={17} />
          </span>
          <span>
            <strong>{item.device.name}</strong>
            <small>{item.device.externalId}</small>
          </span>
        </div>
      </td>
      <td>
        <strong>{item.device.siteName}</strong>
        <small className="table-subtitle">
          {item.device.siteCode}
        </small>
      </td>
      <td>
        <StateBadge state={item.connectivity.state} />
      </td>
      <td>
        <strong>
          {formatAge(item.connectivity.ageSeconds)}
        </strong>
        <small className="table-subtitle">
          {formatDate(
            item.connectivity.lastHeartbeatAt,
          )}
        </small>
      </td>
      <td>
        {temperature === null ||
        temperature === undefined
          ? '—'
          : `${temperature.toFixed(1)}°C`}
      </td>
      <td>
        {storage === null || storage === undefined
          ? '—'
          : `${storage.toFixed(1)}%`}
      </td>
      <td>{item.telemetry?.firmware ?? '—'}</td>
    </tr>
  );
}

function AlertItem({ alert }: { alert: ActiveAlert }) {
  return (
    <article className="alert-item">
      <div
        className={`alert-item__icon alert-item__icon--${alert.severity.toLowerCase()}`}
      >
        <ShieldAlert size={19} />
      </div>

      <div className="alert-item__content">
        <div className="alert-item__title">
          <strong>{alert.title}</strong>
          <span
            className={`severity severity--${alert.severity.toLowerCase()}`}
          >
            {alert.severity}
          </span>
        </div>

        <p>{alert.message}</p>

        <div className="alert-item__meta">
          <span>{alert.siteName}</span>
          <span>{formatDate(alert.openedAt)}</span>
        </div>
      </div>
    </article>
  );
}

function EventItem({
  event,
}: {
  event: ConnectivityEvent;
}) {
  return (
    <article className="event-item">
      <div className="event-item__timeline">
        <span
          className={`event-item__dot event-item__dot--${event.current_state.toLowerCase()}`}
        />
        <span className="event-item__line" />
      </div>

      <div className="event-item__content">
        <div className="event-item__heading">
          <strong>{event.device_name}</strong>
          <StateBadge state={event.current_state} />
        </div>

        <p>
          {event.previous_state
            ? `${stateLabel(event.previous_state)} → ${stateLabel(
                event.current_state,
              )}`
            : `Initial state: ${stateLabel(
                event.current_state,
              )}`}
        </p>

        <small>
          {event.site_id.toUpperCase()} ·{' '}
          {formatDate(event.detected_at)}
        </small>
      </div>
    </article>
  );
}

function LoadingState() {
  return (
    <div className="loading-state">
      <RefreshCw className="spin" size={28} />
      <strong>Loading security operations…</strong>
      <span>Connecting to the PSOP API</span>
    </div>
  );
}

function App() {
  const [overview, setOverview] =
    useState<OperationsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] =
    useState<string | null>(null);
  const [inventoryOpen, setInventoryOpen] =
    useState(false);

  const loadOverview = useCallback(
    async (silent = false) => {
      const controller = new AbortController();

      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        const result = await getOperationsOverview(
          controller.signal,
        );

        setOverview(result);
        setError(null);
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : 'Unable to load PSOP operations',
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }

      return () => controller.abort();
    },
    [],
  );

  useEffect(() => {
    void loadOverview();

    const interval = window.setInterval(() => {
      void loadOverview(true);
    }, REFRESH_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [loadOverview]);

  const healthLabel = useMemo(() => {
    if (!overview) {
      return 'Connecting';
    }

    if (
      overview.summary.offline > 0 ||
      overview.summary.criticalAlerts > 0
    ) {
      return 'Attention required';
    }

    if (
      overview.summary.neverSeen > 0 ||
      overview.summary.unknown > 0
    ) {
      return 'Review recommended';
    }

    return 'All systems operational';
  }, [overview]);

  if (loading && !overview) {
    return <LoadingState />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand__mark">
            <Radio size={22} />
          </div>
          <div>
            <strong>PSOP</strong>
            <span>Physical Security Observability</span>
          </div>
        </div>

        <div className="topbar__actions">
          <button
            className="refresh-button"
            type="button"
            onClick={() => setInventoryOpen(true)}
          >
            <Boxes size={17} />
            Inventory
          </button>

          <div className="system-health">
            <span className="system-health__pulse" />
            <span>{healthLabel}</span>
          </div>

          <button
            className="refresh-button"
            type="button"
            onClick={() => void loadOverview(true)}
            disabled={refreshing}
          >
            <RefreshCw
              size={17}
              className={refreshing ? 'spin' : undefined}
            />
            Refresh
          </button>
        </div>
      </header>

      <main>
        <section className="page-heading">
          <div>
            <span className="eyebrow">Live operations</span>
            <h1>Security operations overview</h1>
            <p>
              Real-time visibility across physical security
              devices, connectivity and active incidents.
            </p>
          </div>

          <div className="page-heading__timestamp">
            <Clock3 size={16} />
            Updated{' '}
            {overview
              ? formatDate(overview.generatedAt)
              : '—'}
          </div>
        </section>

        {error && (
          <div className="error-banner">
            <AlertTriangle size={18} />
            <span>{error}</span>
          </div>
        )}

        {overview && (
          <>
            <section
              className="summary-grid"
              aria-label="Operations summary"
            >
              <SummaryCard
                label="Monitored sites"
                value={overview.summary.sites}
                caption="Active security locations"
                icon={<Building2 size={20} />}
              />

              <SummaryCard
                label="Cameras"
                value={overview.summary.cameras}
                caption="Registered camera devices"
                icon={<Camera size={20} />}
              />

              <SummaryCard
                label="Online"
                value={overview.summary.online}
                caption="Reporting normally"
                icon={<CheckCircle2 size={20} />}
                tone="positive"
              />

              <SummaryCard
                label="Offline"
                value={overview.summary.offline}
                caption="Heartbeat overdue"
                icon={<WifiOff size={20} />}
                tone="danger"
              />

              <SummaryCard
                label="Active alerts"
                value={overview.summary.activeAlerts}
                caption={`${overview.summary.criticalAlerts} critical`}
                icon={<ShieldAlert size={20} />}
                tone={
                  overview.summary.activeAlerts > 0
                    ? 'danger'
                    : 'neutral'
                }
              />

              <SummaryCard
                label="Unknown"
                value={
                  overview.summary.unknown +
                  overview.summary.neverSeen
                }
                caption="Needs verification"
                icon={<Database size={20} />}
                tone="warning"
              />
            </section>

            <section className="workspace-grid">
              <div className="panel panel--fleet">
                <div className="panel__header">
                  <div>
                    <span className="eyebrow">
                      Device health
                    </span>
                    <h2>Camera fleet</h2>
                  </div>

                  <span className="panel__count">
                    {overview.fleet.length} devices
                  </span>
                </div>

                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Device</th>
                        <th>Site</th>
                        <th>State</th>
                        <th>Last heartbeat</th>
                        <th>Temp.</th>
                        <th>Storage</th>
                        <th>Firmware</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.fleet.map((item) => (
                        <FleetRow
                          key={item.device.id}
                          item={item}
                          onSelect={() =>
                            setSelectedDeviceId(
                              item.device.id,
                            )
                          }
                        />
                      ))}
                    </tbody>
                  </table>
                </div>

                {overview.fleet.length === 0 && (
                  <div className="empty-state">
                    <Server size={26} />
                    <strong>No cameras registered</strong>
                    <span>
                      Add a camera device to begin monitoring.
                    </span>
                  </div>
                )}
              </div>

              <aside className="side-column">
                <div className="panel">
                  <div className="panel__header">
                    <div>
                      <span className="eyebrow">
                        Incident queue
                      </span>
                      <h2>Active alerts</h2>
                    </div>

                    <span className="panel__count">
                      {overview.activeAlerts.length}
                    </span>
                  </div>

                  <div className="alert-list">
                    {overview.activeAlerts.map((alert) => (
                      <AlertItem
                        key={alert.id}
                        alert={alert}
                      />
                    ))}

                    {overview.activeAlerts.length === 0 && (
                      <div className="empty-state empty-state--compact">
                        <CheckCircle2 size={25} />
                        <strong>No active alerts</strong>
                        <span>
                          The monitored fleet is clear.
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="panel">
                  <div className="panel__header">
                    <div>
                      <span className="eyebrow">
                        Activity stream
                      </span>
                      <h2>Recent events</h2>
                    </div>

                    <Activity size={19} />
                  </div>

                  <div className="event-list">
                    {overview.recentEvents
                      .slice(0, 8)
                      .map((event) => (
                        <EventItem
                          key={`${event.camera_id}-${event.timestamp}`}
                          event={event}
                        />
                      ))}

                    {overview.recentEvents.length === 0 && (
                      <div className="empty-state empty-state--compact">
                        <Clock3 size={25} />
                        <strong>No recent events</strong>
                        <span>
                          Connectivity changes will appear
                          here.
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </aside>
            </section>
          </>
        )}
      </main>

      {inventoryOpen && (
        <InventoryPanel
          onClose={() => setInventoryOpen(false)}
          onChanged={() => void loadOverview(true)}
        />
      )}

      {selectedDeviceId && (
        <DeviceDetailsPanel
          deviceId={selectedDeviceId}
          onClose={() => setSelectedDeviceId(null)}
        />
      )}
    </div>
  );
}

export default App;
