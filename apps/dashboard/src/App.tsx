import {
  History,
  Users,
  Activity,
  ArrowUpDown,
  AlertTriangle,
  Building2,
  Boxes,
  Camera,
  CheckCircle2,
  Clock3,
  Database,
  Radio,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  SlidersHorizontal,
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
import AlertManagementPanel from './AlertManagementPanel';
import SiteDetailsPanel from './SiteDetailsPanel';
import UserManagementPanel from './UserManagementPanel';
import AuditLogPanel from './AuditLogPanel';
import { useAuthUser } from './AuthGate';
import type {
  ActiveAlert,
  ConnectivityEvent,
  ConnectivityState,
  FleetDevice,
  OperationsOverview,
} from './types';

const REFRESH_INTERVAL_MS = 15_000;

type FleetStateFilter = ConnectivityState | 'ALL';

type FleetSort =
  | 'STATE'
  | 'NAME'
  | 'SITE'
  | 'HEARTBEAT';

const connectivityOrder: Record<
  ConnectivityState,
  number
> = {
  OFFLINE: 0,
  NEVER_SEEN: 1,
  UNKNOWN: 2,
  ONLINE: 3,
};

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
  const authUser = useAuthUser();
  const [overview, setOverview] =
    useState<OperationsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] =
    useState<string | null>(null);
  const [inventoryOpen, setInventoryOpen] =
    useState(false);
  const [alertManagementOpen, setAlertManagementOpen] =
    useState(false);
  const [userManagementOpen, setUserManagementOpen] =
    useState(false);
  const [auditLogOpen, setAuditLogOpen] = useState(false);
  const [siteDetailsOpen, setSiteDetailsOpen] =
    useState(false);
  const [fleetSearch, setFleetSearch] = useState('');
  const [fleetSite, setFleetSite] = useState('ALL');
  const [fleetState, setFleetState] =
    useState<FleetStateFilter>('ALL');
  const [fleetSort, setFleetSort] =
    useState<FleetSort>('STATE');

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

  const fleetSites = useMemo(() => {
    if (!overview) {
      return [];
    }

    const sites = new Map<string, string>();

    for (const item of overview.fleet) {
      sites.set(
        item.device.siteId,
        `${item.device.siteName} (${item.device.siteCode})`,
      );
    }

    return Array.from(sites.entries()).sort(
      ([, first], [, second]) =>
        first.localeCompare(second),
    );
  }, [overview]);

  const filteredFleet = useMemo(() => {
    if (!overview) {
      return [];
    }

    const normalizedSearch = fleetSearch
      .trim()
      .toLowerCase();

    return overview.fleet
      .filter((item) => {
        const matchesSearch =
          !normalizedSearch ||
          [
            item.device.name,
            item.device.externalId,
            item.device.siteName,
            item.device.siteCode,
          ]
            .join(' ')
            .toLowerCase()
            .includes(normalizedSearch);

        const matchesSite =
          fleetSite === 'ALL' ||
          item.device.siteId === fleetSite;

        const matchesState =
          fleetState === 'ALL' ||
          item.connectivity.state === fleetState;

        return (
          matchesSearch &&
          matchesSite &&
          matchesState
        );
      })
      .sort((first, second) => {
        if (fleetSort === 'NAME') {
          return first.device.name.localeCompare(
            second.device.name,
          );
        }

        if (fleetSort === 'SITE') {
          return (
            first.device.siteName.localeCompare(
              second.device.siteName,
            ) ||
            first.device.name.localeCompare(
              second.device.name,
            )
          );
        }

        if (fleetSort === 'HEARTBEAT') {
          return (
            (second.connectivity.ageSeconds ?? -1) -
            (first.connectivity.ageSeconds ?? -1)
          );
        }

        return (
          connectivityOrder[
            first.connectivity.state
          ] -
            connectivityOrder[
              second.connectivity.state
            ] ||
          first.device.name.localeCompare(
            second.device.name,
          )
        );
      });
  }, [
    overview,
    fleetSearch,
    fleetSite,
    fleetState,
    fleetSort,
  ]);

  const hasFleetFilters =
    fleetSearch.trim() !== '' ||
    fleetSite !== 'ALL' ||
    fleetState !== 'ALL' ||
    fleetSort !== 'STATE';

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
          {authUser.role === 'ADMIN' && (
            <button
              className="refresh-button"
              type="button"
              onClick={() =>
                setAuditLogOpen(true)
              }
            >
              <History size={17} />
              Audit
            </button>
          )}

          {authUser.role === 'ADMIN' && (
            <button
              className="refresh-button"
              type="button"
              onClick={() =>
                setUserManagementOpen(true)
              }
            >
              <Users size={17} />
              Users
            </button>
          )}
          <button
            className="refresh-button"
            type="button"
            onClick={() => setSiteDetailsOpen(true)}
          >
            <Building2 size={17} />
            Sites
          </button>

          <button
            className="refresh-button"
            type="button"
            onClick={() => setInventoryOpen(true)}
          >
            <Boxes size={17} />
            Inventory
          </button>

          <button
            className="refresh-button"
            type="button"
            onClick={() => setAlertManagementOpen(true)}
          >
            <ShieldAlert size={17} />
            Alerts
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
                    {filteredFleet.length ===
                    overview.fleet.length
                      ? `${overview.fleet.length} devices`
                      : `${filteredFleet.length} of ${overview.fleet.length}`}
                  </span>
                </div>

                <div className="fleet-toolbar">
                  <label className="fleet-search">
                    <Search size={17} />
                    <input
                      value={fleetSearch}
                      onChange={(event) =>
                        setFleetSearch(
                          event.target.value,
                        )
                      }
                      placeholder="Search camera, ID or site"
                    />
                  </label>

                  <div className="fleet-filter-group">
                    <label className="fleet-select">
                      <SlidersHorizontal size={16} />
                      <select
                        value={fleetSite}
                        onChange={(event) =>
                          setFleetSite(
                            event.target.value,
                          )
                        }
                        aria-label="Filter by site"
                      >
                        <option value="ALL">
                          All sites
                        </option>

                        {fleetSites.map(
                          ([siteId, label]) => (
                            <option
                              key={siteId}
                              value={siteId}
                            >
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                    </label>

                    <label className="fleet-select">
                      <select
                        value={fleetState}
                        onChange={(event) =>
                          setFleetState(
                            event.target
                              .value as FleetStateFilter,
                          )
                        }
                        aria-label="Filter by state"
                      >
                        <option value="ALL">
                          All states
                        </option>
                        <option value="ONLINE">
                          Online
                        </option>
                        <option value="OFFLINE">
                          Offline
                        </option>
                        <option value="NEVER_SEEN">
                          Never seen
                        </option>
                        <option value="UNKNOWN">
                          Unknown
                        </option>
                      </select>
                    </label>

                    <label className="fleet-select">
                      <ArrowUpDown size={16} />
                      <select
                        value={fleetSort}
                        onChange={(event) =>
                          setFleetSort(
                            event.target
                              .value as FleetSort,
                          )
                        }
                        aria-label="Sort fleet"
                      >
                        <option value="STATE">
                          Priority
                        </option>
                        <option value="NAME">
                          Camera name
                        </option>
                        <option value="SITE">
                          Site
                        </option>
                        <option value="HEARTBEAT">
                          Heartbeat age
                        </option>
                      </select>
                    </label>

                    {hasFleetFilters && (
                      <button
                        type="button"
                        className="fleet-clear"
                        onClick={() => {
                          setFleetSearch('');
                          setFleetSite('ALL');
                          setFleetState('ALL');
                          setFleetSort('STATE');
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </div>
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
                      {filteredFleet.map((item) => (
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

                {filteredFleet.length === 0 && (
                  <div className="empty-state">
                    <Server size={26} />
                    <strong>
                      {overview.fleet.length === 0
                        ? 'No cameras registered'
                        : 'No cameras match the filters'}
                    </strong>
                    <span>
                      {overview.fleet.length === 0
                        ? 'Add a camera device to begin monitoring.'
                        : 'Adjust the search or clear the selected filters.'}
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

      {auditLogOpen && (
        <AuditLogPanel
          onClose={() => setAuditLogOpen(false)}
        />
      )}

      {userManagementOpen && (
        <UserManagementPanel
          currentUserId={authUser.id}
          onClose={() =>
            setUserManagementOpen(false)
          }
        />
      )}

      {siteDetailsOpen && (
        <SiteDetailsPanel
          onClose={() => setSiteDetailsOpen(false)}
          onSelectDevice={(deviceId) => {
            setSiteDetailsOpen(false);
            setSelectedDeviceId(deviceId);
          }}
        />
      )}

      {alertManagementOpen && (
        <AlertManagementPanel
          onClose={() => setAlertManagementOpen(false)}
          onChanged={() => void loadOverview(true)}
        />
      )}

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
