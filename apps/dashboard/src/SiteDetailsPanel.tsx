import {
  AlertTriangle,
  Building2,
  Camera,
  CheckCircle2,
  Cpu,
  HardDrive,
  LoaderCircle,
  MapPin,
  Network,
  Radio,
  RefreshCw,
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
  getDevices,
  getOperationsOverview,
  getSites,
} from './api';
import type {
  DeviceAlert,
  DeviceType,
  InventoryDevice,
  OperationsOverview,
  Site,
} from './types';

interface SiteDetailsPanelProps {
  onClose: () => void;
  onSelectDevice: (deviceId: string) => void;
}

function deviceTypeLabel(type: DeviceType): string {
  const labels: Record<DeviceType, string> = {
    CAMERA: 'Camera',
    RECORDER: 'DVR / NVR / Recorder',
    GATEWAY: 'Gateway',
    ACCESS_CONTROLLER: 'Access controller',
    SENSOR: 'Sensor',
    INTERCOM: 'Intercom',
    NETWORK_SWITCH: 'Network switch',
  };

  return labels[type];
}

function EquipmentIcon({ type }: { type: DeviceType }) {
  if (type === 'CAMERA') {
    return <Camera size={18} />;
  }

  if (type === 'RECORDER') {
    return <HardDrive size={18} />;
  }

  if (
    type === 'GATEWAY' ||
    type === 'NETWORK_SWITCH'
  ) {
    return <Network size={18} />;
  }

  if (type === 'INTERCOM') {
    return <Radio size={18} />;
  }

  return <Cpu size={18} />;
}

export default function SiteDetailsPanel({
  onClose,
  onSelectDevice,
}: SiteDetailsPanelProps) {
  const [sites, setSites] = useState<Site[]>([]);
  const [devices, setDevices] = useState<InventoryDevice[]>(
    [],
  );
  const [overview, setOverview] =
    useState<OperationsOverview | null>(null);
  const [alerts, setAlerts] = useState<DeviceAlert[]>([]);
  const [selectedSiteId, setSelectedSiteId] =
    useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDetails = useCallback(
    async (silent = false) => {
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        const [
          siteResult,
          deviceResult,
          overviewResult,
          alertResult,
        ] = await Promise.all([
          getSites(),
          getDevices(),
          getOperationsOverview(),
          getAlerts('OPEN'),
        ]);

        setSites(siteResult);
        setDevices(deviceResult);
        setOverview(overviewResult);
        setAlerts(alertResult);

        setSelectedSiteId((current) => {
          if (
            current &&
            siteResult.some((site) => site.id === current)
          ) {
            return current;
          }

          return siteResult.at(0)?.id ?? null;
        });

        setError(null);
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : 'Unable to load site details',
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [],
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

  const gatewayById = useMemo(
    () =>
      new Map(
        devices.map((device) => [
          device.id,
          device,
        ]),
      ),
    [devices],
  );

  const selectedSite = useMemo(
    () =>
      sites.find((site) => site.id === selectedSiteId) ??
      null,
    [sites, selectedSiteId],
  );

  const siteDevices = useMemo(
    () =>
      devices.filter(
        (device) => device.siteId === selectedSiteId,
      ),
    [devices, selectedSiteId],
  );

  const siteCameras = useMemo(
    () =>
      overview?.fleet.filter(
        (item) =>
          item.device.siteId === selectedSiteId,
      ) ?? [],
    [overview, selectedSiteId],
  );

  const siteAlerts = useMemo(() => {
    const deviceIds = new Set(
      siteDevices.map((device) => device.id),
    );

    return alerts.filter(
      (alert) =>
        deviceIds.has(alert.deviceId) ||
        alert.device?.site.id === selectedSiteId,
    );
  }, [alerts, siteDevices, selectedSiteId]);

  const summary = useMemo(
    () => ({
      equipment: siteDevices.length,
      cameras: siteCameras.length,
      online: siteCameras.filter(
        (item) =>
          item.connectivity.state === 'ONLINE',
      ).length,
      degraded: siteCameras.filter(
        (item) =>
          item.connectivity.state === 'DEGRADED',
      ).length,
      offline: siteCameras.filter(
        (item) =>
          item.connectivity.state === 'OFFLINE',
      ).length,
      attention: siteCameras.filter((item) =>
        ['NEVER_SEEN', 'UNKNOWN'].includes(
          item.connectivity.state,
        ),
      ).length,
      alerts: siteAlerts.length,
    }),
    [siteDevices, siteCameras, siteAlerts],
  );

  return (
    <div
      className="site-details-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="site-details-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Site operations"
      >
        <header className="site-details-header">
          <div className="site-details-title">
            <span className="site-details-title__icon">
              <Building2 size={22} />
            </span>

            <div>
              <span className="eyebrow">
                Location intelligence
              </span>
              <h2>Site operations</h2>
              <p>
                Operational health, equipment and active
                incidents by monitored location.
              </p>
            </div>
          </div>

          <div className="site-details-actions">
            <button
              type="button"
              className="icon-button"
              onClick={() => void loadDetails(true)}
              disabled={refreshing}
              aria-label="Refresh sites"
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
              aria-label="Close site operations"
            >
              <X size={20} />
            </button>
          </div>
        </header>

        {error && (
          <div className="inventory-message inventory-message--error">
            {error}
          </div>
        )}

        {loading ? (
          <div className="site-details-loading">
            <LoaderCircle className="spin" size={28} />
            <strong>Loading site operations…</strong>
          </div>
        ) : (
          <div className="site-details-layout">
            <aside className="site-selector">
              <div className="site-selector__heading">
                <span className="eyebrow">
                  Monitored locations
                </span>
                <strong>{sites.length} sites</strong>
              </div>

              <div className="site-selector__list">
                {sites.map((site) => {
                  const count = devices.filter(
                    (device) =>
                      device.siteId === site.id,
                  ).length;

                  return (
                    <button
                      type="button"
                      key={site.id}
                      className={
                        selectedSiteId === site.id
                          ? 'site-selector-card site-selector-card--active'
                          : 'site-selector-card'
                      }
                      onClick={() =>
                        setSelectedSiteId(site.id)
                      }
                    >
                      <span>
                        <Building2 size={18} />
                      </span>

                      <div>
                        <strong>{site.name}</strong>
                        <small>
                          {site.code} · {count}{' '}
                          {count === 1
                            ? 'device'
                            : 'devices'}
                        </small>
                      </div>
                    </button>
                  );
                })}
              </div>
            </aside>

            {selectedSite ? (
              <main className="site-details-content">
                <section className="site-profile">
                  <div>
                    <span className="eyebrow">
                      Selected site
                    </span>
                    <h3>{selectedSite.name}</h3>

                    <p>
                      <MapPin size={15} />
                      {selectedSite.address ||
                        selectedSite.timezone ||
                        'No location information'}
                    </p>
                  </div>

                  <div className="site-profile__meta">
                    <span>{selectedSite.code}</span>
                    <strong>{selectedSite.status}</strong>
                  </div>
                </section>

                <section className="site-summary-grid">
                  <article>
                    <span>Equipment</span>
                    <strong>{summary.equipment}</strong>
                  </article>

                  <article>
                    <span>Cameras</span>
                    <strong>{summary.cameras}</strong>
                  </article>

                  <article className="site-summary-online">
                    <span>Online</span>
                    <strong>{summary.online}</strong>
                  </article>

                  <article className="site-summary-warning">
                    <span>Degraded</span>
                    <strong>{summary.degraded}</strong>
                  </article>

                  <article className="site-summary-offline">
                    <span>Offline</span>
                    <strong>{summary.offline}</strong>
                  </article>

                  <article className="site-summary-warning">
                    <span>Needs review</span>
                    <strong>{summary.attention}</strong>
                  </article>

                  <article className="site-summary-offline">
                    <span>Active alerts</span>
                    <strong>{summary.alerts}</strong>
                  </article>
                </section>

                <section className="site-panel">
                  <div className="site-panel__heading">
                    <div>
                      <span className="eyebrow">
                        Physical assets
                      </span>
                      <h3>Equipment</h3>
                    </div>

                    <span className="panel__count">
                      {siteDevices.length}
                    </span>
                  </div>

                  <div className="site-equipment-list">
                    {siteDevices.map((device) => {
                      const camera = siteCameras.find(
                        (item) =>
                          item.device.id === device.id,
                      );

                      return (
                        <button
                          type="button"
                          className={
                            device.deviceType === 'CAMERA'
                              ? 'site-equipment site-equipment--clickable'
                              : 'site-equipment'
                          }
                          key={device.id}
                          disabled={
                            device.deviceType !== 'CAMERA'
                          }
                          onClick={() => {
                            if (
                              device.deviceType === 'CAMERA'
                            ) {
                              onSelectDevice(device.id);
                            }
                          }}
                        >
                          <span className="site-equipment__icon">
                            <EquipmentIcon
                              type={device.deviceType}
                            />
                          </span>

                          <div className="site-equipment__identity">
                            <strong>{device.name}</strong>
                            <small>
                              {device.externalId} ·{' '}
                              {deviceTypeLabel(
                                device.deviceType,
                              )}
                            </small>
                          </div>

                          <div>
                            <strong>
                              {device.manufacturer ||
                                device.model ||
                                'Not specified'}
                            </strong>
                            <small>
                              {device.monitoringMode ===
                                'VIA_GATEWAY'
                                ? `Via ${
                                    gatewayById.get(
                                      device.gatewayDeviceId ??
                                        '',
                                    )?.name ??
                                    'gateway'
                                  }`
                                : device.monitoringMode ===
                                    'INVENTORY_ONLY'
                                  ? 'Inventory only'
                                  : device.ipAddress ||
                                    device.firmwareVersion ||
                                    'Direct monitoring'}
                            </small>
                          </div>

                          {device.monitoringMode ===
                          'VIA_GATEWAY' ? (
                            <span className="inventory-status">
                              VIA GATEWAY
                            </span>
                          ) : camera ? (
                            <span
                              className={`badge badge--${camera.connectivity.state.toLowerCase()}`}
                            >
                              {camera.connectivity.state}
                            </span>
                          ) : (
                            <span className="inventory-status">
                              {device.status}
                            </span>
                          )}
                        </button>
                      );
                    })}

                    {siteDevices.length === 0 && (
                      <div className="details-empty">
                        <HardDrive size={25} />
                        <strong>No equipment</strong>
                        <span>
                          Register equipment through the
                          inventory panel.
                        </span>
                      </div>
                    )}
                  </div>
                </section>

                <section className="site-panel">
                  <div className="site-panel__heading">
                    <div>
                      <span className="eyebrow">
                        Incident queue
                      </span>
                      <h3>Active alerts</h3>
                    </div>

                    <span className="panel__count">
                      {siteAlerts.length}
                    </span>
                  </div>

                  <div className="site-alert-list">
                    {siteAlerts.map((alert) => (
                      <article
                        className="site-alert"
                        key={alert.id}
                      >
                        <span
                          className={`site-alert__icon site-alert__icon--${alert.severity.toLowerCase()}`}
                        >
                          <AlertTriangle size={18} />
                        </span>

                        <div>
                          <strong>{alert.title}</strong>
                          <p>{alert.message}</p>
                          <small>
                            {alert.device?.name ??
                              alert.deviceId}
                          </small>
                        </div>

                        <span
                          className={`severity severity--${alert.severity.toLowerCase()}`}
                        >
                          {alert.severity}
                        </span>
                      </article>
                    ))}

                    {siteAlerts.length === 0 && (
                      <div className="details-empty">
                        <CheckCircle2 size={25} />
                        <strong>No active alerts</strong>
                        <span>
                          This site has no active incidents.
                        </span>
                      </div>
                    )}
                  </div>
                </section>
              </main>
            ) : (
              <div className="details-empty">
                <Building2 size={28} />
                <strong>No sites registered</strong>
                <span>
                  Create a site through Inventory.
                </span>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
