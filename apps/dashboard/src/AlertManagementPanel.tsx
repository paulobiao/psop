import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  getAlerts,
  resolveAlert,
} from './api';
import type { DeviceAlert } from './types';

type AlertFilter = 'OPEN' | 'RESOLVED' | 'ALL';

interface AlertManagementPanelProps {
  onClose: () => void;
  onChanged: () => void;
}

function formatDate(value: string | null): string {
  if (!value) {
    return '—';
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

export default function AlertManagementPanel({
  onClose,
  onChanged,
}: AlertManagementPanelProps) {
  const [alerts, setAlerts] = useState<DeviceAlert[]>([]);
  const [filter, setFilter] =
    useState<AlertFilter>('OPEN');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [resolvingId, setResolvingId] =
    useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAlerts = useCallback(
    async (silent = false) => {
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        const result = await getAlerts(
          filter === 'ALL' ? undefined : filter,
        );

        setAlerts(result);
        setError(null);
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : 'Unable to load alerts',
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [filter],
  );

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts]);

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

  const filteredAlerts = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    if (!normalizedSearch) {
      return alerts;
    }

    return alerts.filter((alert) => {
      const content = [
        alert.title,
        alert.message,
        alert.device?.name,
        alert.device?.externalId,
        alert.device?.site.name,
        alert.device?.site.code,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return content.includes(normalizedSearch);
    });
  }, [alerts, search]);

  const counts = useMemo(
    () => ({
      total: alerts.length,
      critical: alerts.filter(
        (alert) => alert.severity === 'CRITICAL',
      ).length,
      warning: alerts.filter(
        (alert) => alert.severity === 'WARNING',
      ).length,
    }),
    [alerts],
  );

  async function handleResolve(alert: DeviceAlert) {
    const confirmed = window.confirm(
      `Resolve the alert "${alert.title}"?`,
    );

    if (!confirmed) {
      return;
    }

    setResolvingId(alert.id);
    setError(null);

    try {
      await resolveAlert(alert.id);
      await loadAlerts(true);
      onChanged();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to resolve alert',
      );
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <div
      className="alert-management-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="alert-management-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Alert management"
      >
        <header className="alert-management-header">
          <div className="alert-management-title">
            <span className="alert-management-title__icon">
              <ShieldAlert size={22} />
            </span>

            <div>
              <span className="eyebrow">
                Incident administration
              </span>
              <h2>Alert management</h2>
              <p>
                Review active incidents, historical alerts
                and manually resolve verified conditions.
              </p>
            </div>
          </div>

          <div className="alert-management-actions">
            <button
              type="button"
              className="icon-button"
              onClick={() => void loadAlerts(true)}
              disabled={refreshing}
              aria-label="Refresh alerts"
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
              aria-label="Close alert management"
            >
              <X size={20} />
            </button>
          </div>
        </header>

        <div className="alert-management-toolbar">
          <div className="alert-filter-group">
            {(
              [
                ['OPEN', 'Active'],
                ['RESOLVED', 'Resolved'],
                ['ALL', 'All'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={
                  filter === value
                    ? 'alert-filter alert-filter--active'
                    : 'alert-filter'
                }
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="alert-search">
            <Search size={17} />
            <input
              value={search}
              onChange={(event) =>
                setSearch(event.target.value)
              }
              placeholder="Search camera, site or alert"
            />
          </label>
        </div>

        {error && (
          <div className="inventory-message inventory-message--error">
            {error}
          </div>
        )}

        <div className="alert-management-summary">
          <article>
            <span>Displayed alerts</span>
            <strong>{filteredAlerts.length}</strong>
          </article>

          <article>
            <span>Critical</span>
            <strong className="alert-summary-danger">
              {counts.critical}
            </strong>
          </article>

          <article>
            <span>Warning</span>
            <strong className="alert-summary-warning">
              {counts.warning}
            </strong>
          </article>

          <article>
            <span>Current filter</span>
            <strong>{filter}</strong>
          </article>
        </div>

        {loading ? (
          <div className="alert-management-loading">
            <LoaderCircle className="spin" size={28} />
            <strong>Loading alerts…</strong>
          </div>
        ) : (
          <div className="alert-management-list">
            {filteredAlerts.map((alert) => (
              <article
                className="managed-alert"
                key={alert.id}
              >
                <span
                  className={`managed-alert__icon managed-alert__icon--${alert.severity.toLowerCase()}`}
                >
                  {alert.status === 'RESOLVED' ? (
                    <CheckCircle2 size={20} />
                  ) : (
                    <AlertTriangle size={20} />
                  )}
                </span>

                <div className="managed-alert__content">
                  <div className="managed-alert__heading">
                    <div>
                      <strong>{alert.title}</strong>
                      <small>
                        {alert.device?.name ??
                          alert.deviceId}
                        {alert.device?.site
                          ? ` · ${alert.device.site.name} (${alert.device.site.code})`
                          : ''}
                      </small>
                    </div>

                    <div className="managed-alert__badges">
                      <span
                        className={`severity severity--${alert.severity.toLowerCase()}`}
                      >
                        {alert.severity}
                      </span>

                      <span
                        className={
                          alert.status === 'OPEN'
                            ? 'managed-alert-status managed-alert-status--open'
                            : 'managed-alert-status managed-alert-status--resolved'
                        }
                      >
                        {alert.status}
                      </span>
                    </div>
                  </div>

                  <p>{alert.message}</p>

                  <div className="managed-alert__dates">
                    <span>
                      <Clock3 size={14} />
                      Opened {formatDate(alert.openedAt)}
                    </span>

                    <span>
                      Last detected{' '}
                      {formatDate(alert.lastDetectedAt)}
                    </span>

                    {alert.resolvedAt && (
                      <span>
                        Resolved{' '}
                        {formatDate(alert.resolvedAt)}
                      </span>
                    )}
                  </div>
                </div>

                {alert.status === 'OPEN' && (
                  <button
                    type="button"
                    className="resolve-alert-button"
                    onClick={() =>
                      void handleResolve(alert)
                    }
                    disabled={resolvingId === alert.id}
                  >
                    {resolvingId === alert.id ? (
                      <LoaderCircle
                        className="spin"
                        size={17}
                      />
                    ) : (
                      <CheckCircle2 size={17} />
                    )}
                    Resolve
                  </button>
                )}
              </article>
            ))}

            {filteredAlerts.length === 0 && (
              <div className="details-empty alert-management-empty">
                <CheckCircle2 size={28} />
                <strong>No matching alerts</strong>
                <span>
                  No incidents match the selected filter and
                  search.
                </span>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
