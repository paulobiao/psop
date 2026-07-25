import {
  Boxes,
  Building2,
  Camera,
  CirclePlus,
  Cpu,
  HardDrive,
  LoaderCircle,
  Pencil,
  Network,
  Radio,
  Trash2,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  createDevice,
  createSite,
  deleteDevice,
  getDevices,
  getSites,
} from './api';
import InventoryEditPanel from './InventoryEditPanel';
import type {
  CreateDeviceInput,
  DeviceType,
  InventoryDevice,
  Site,
} from './types';

interface InventoryPanelProps {
  onClose: () => void;
  onChanged: () => void;
}

const deviceTypes: Array<{
  value: DeviceType;
  label: string;
}> = [
  { value: 'CAMERA', label: 'Camera' },
  { value: 'RECORDER', label: 'DVR / NVR / Recorder' },
  { value: 'GATEWAY', label: 'Gateway' },
  {
    value: 'ACCESS_CONTROLLER',
    label: 'Access controller',
  },
  { value: 'SENSOR', label: 'Sensor' },
  { value: 'INTERCOM', label: 'Intercom' },
  { value: 'NETWORK_SWITCH', label: 'Network switch' },
];

function deviceTypeLabel(type: DeviceType): string {
  return (
    deviceTypes.find((item) => item.value === type)?.label ??
    type
  );
}

function DeviceIcon({ type }: { type: DeviceType }) {
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

export default function InventoryPanel({
  onClose,
  onChanged,
}: InventoryPanelProps) {
  const [sites, setSites] = useState<Site[]>([]);
  const [devices, setDevices] = useState<InventoryDevice[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<
    'site' | 'device' | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(
    null,
  );
  const [editingSite, setEditingSite] =
    useState<Site | null>(null);
  const [editingDevice, setEditingDevice] =
    useState<InventoryDevice | null>(null);

  const [siteForm, setSiteForm] = useState({
    name: '',
    code: '',
    timezone: 'America/New_York',
    address: '',
  });

  const [deviceForm, setDeviceForm] =
    useState<CreateDeviceInput>({
      siteId: '',
      name: '',
      externalId: '',
      deviceType: 'CAMERA',
      manufacturer: '',
      model: '',
      firmwareVersion: '',
      ipAddress: '',
      serialNumber: '',
      expectedHeartbeatInterval: 60,
      status: 'ACTIVE',
    });

  const loadInventory = useCallback(async () => {
    setLoading(true);

    try {
      const [siteResult, deviceResult] =
        await Promise.all([getSites(), getDevices()]);

      setSites(siteResult);
      setDevices(deviceResult);

      setDeviceForm((current) => ({
        ...current,
        siteId:
          current.siteId ||
          siteResult.at(0)?.id ||
          '',
      }));

      setError(null);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to load inventory',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInventory();
  }, [loadInventory]);

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

  const siteById = useMemo(
    () =>
      new Map(sites.map((site) => [site.id, site])),
    [sites],
  );

  async function handleCreateSite(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    setSubmitting('site');
    setError(null);
    setSuccess(null);

    try {
      const site = await createSite({
        name: siteForm.name.trim(),
        code: siteForm.code.trim().toUpperCase(),
        timezone: siteForm.timezone.trim() || undefined,
        address: siteForm.address.trim() || undefined,
        status: 'ACTIVE',
      });

      setSiteForm({
        name: '',
        code: '',
        timezone: 'America/New_York',
        address: '',
      });

      setDeviceForm((current) => ({
        ...current,
        siteId: site.id,
      }));

      setSuccess(`Site ${site.name} created.`);
      await loadInventory();
      onChanged();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to create site',
      );
    } finally {
      setSubmitting(null);
    }
  }

  async function handleCreateDevice(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    setSubmitting('device');
    setError(null);
    setSuccess(null);

    try {
      const device = await createDevice({
        ...deviceForm,
        name: deviceForm.name.trim(),
        externalId: deviceForm.externalId.trim(),
        manufacturer:
          deviceForm.manufacturer?.trim() || undefined,
        model: deviceForm.model?.trim() || undefined,
        firmwareVersion:
          deviceForm.firmwareVersion?.trim() ||
          undefined,
        ipAddress:
          deviceForm.ipAddress?.trim() || undefined,
        serialNumber:
          deviceForm.serialNumber?.trim() ||
          undefined,
      });

      setDeviceForm((current) => ({
        ...current,
        name: '',
        externalId: '',
        manufacturer: '',
        model: '',
        firmwareVersion: '',
        ipAddress: '',
        serialNumber: '',
      }));

      setSuccess(`Device ${device.name} created.`);
      await loadInventory();
      onChanged();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to create device',
      );
    } finally {
      setSubmitting(null);
    }
  }

  async function handleDeleteDevice(
    device: InventoryDevice,
  ) {
    const confirmed = window.confirm(
      `Remove ${device.name} from the active inventory?`,
    );

    if (!confirmed) {
      return;
    }

    setError(null);
    setSuccess(null);

    try {
      await deleteDevice(device.id);
      setSuccess(`${device.name} removed.`);
      await loadInventory();
      onChanged();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to remove device',
      );
    }
  }

  return (
    <div
      className="inventory-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="inventory-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Inventory management"
      >
        <header className="inventory-header">
          <div>
            <span className="eyebrow">
              Asset administration
            </span>
            <h2>Sites and equipment</h2>
            <p>
              Register locations, cameras, recorders and
              supporting physical-security infrastructure.
            </p>
          </div>

          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close inventory"
          >
            <X size={20} />
          </button>
        </header>

        {error && (
          <div className="inventory-message inventory-message--error">
            {error}
          </div>
        )}

        {success && (
          <div className="inventory-message inventory-message--success">
            {success}
          </div>
        )}

        {loading ? (
          <div className="inventory-loading">
            <LoaderCircle className="spin" size={27} />
            <strong>Loading inventory…</strong>
          </div>
        ) : (
          <div className="inventory-layout">
            <div className="inventory-content">
              <section className="inventory-section">
                <div className="inventory-section__heading">
                  <div>
                    <span className="eyebrow">
                      Locations
                    </span>
                    <h3>Monitored sites</h3>
                  </div>
                  <span className="panel__count">
                    {sites.length}
                  </span>
                </div>

                <div className="site-grid">
                  {sites.map((site) => {
                    const count = devices.filter(
                      (device) =>
                        device.siteId === site.id,
                    ).length;

                    return (
                      <article
                        className="inventory-site-card"
                        key={site.id}
                      >
                        <span className="inventory-site-card__icon">
                          <Building2 size={20} />
                        </span>

                        <div>
                          <strong>{site.name}</strong>
                          <small>
                            {site.code} · {count}{' '}
                            {count === 1
                              ? 'device'
                              : 'devices'}
                          </small>
                          <p>
                            {site.address ||
                              site.timezone ||
                              'No location details'}
                          </p>
                        </div>

                        <button
                          type="button"
                          className="inventory-card-edit"
                          onClick={() =>
                            setEditingSite(site)
                          }
                          aria-label={`Edit ${site.name}`}
                        >
                          <Pencil size={16} />
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="inventory-section">
                <div className="inventory-section__heading">
                  <div>
                    <span className="eyebrow">
                      Registered assets
                    </span>
                    <h3>Equipment inventory</h3>
                  </div>
                  <span className="panel__count">
                    {devices.length}
                  </span>
                </div>

                <div className="inventory-device-list">
                  {devices.map((device) => (
                    <article
                      className="inventory-device"
                      key={device.id}
                    >
                      <span className="inventory-device__icon">
                        <DeviceIcon
                          type={device.deviceType}
                        />
                      </span>

                      <div className="inventory-device__identity">
                        <strong>{device.name}</strong>
                        <small>
                          {device.externalId} ·{' '}
                          {deviceTypeLabel(
                            device.deviceType,
                          )}
                        </small>
                      </div>

                      <div className="inventory-device__site">
                        <strong>
                          {siteById.get(device.siteId)
                            ?.name ?? 'Unknown site'}
                        </strong>
                        <small>
                          {device.manufacturer ||
                            device.model ||
                            'No manufacturer'}
                        </small>
                      </div>

                      <span className="inventory-status">
                        {device.status}
                      </span>

                      <div className="inventory-device__actions">
                        <button
                          type="button"
                          className="inventory-edit-button"
                          onClick={() =>
                            setEditingDevice(device)
                          }
                          aria-label={`Edit ${device.name}`}
                        >
                          <Pencil size={17} />
                        </button>

                        <button
                          type="button"
                          className="inventory-delete"
                          onClick={() =>
                            void handleDeleteDevice(device)
                          }
                          aria-label={`Remove ${device.name}`}
                        >
                          <Trash2 size={17} />
                        </button>
                      </div>
                    </article>
                  ))}

                  {devices.length === 0 && (
                    <div className="details-empty">
                      <Boxes size={25} />
                      <strong>No equipment registered</strong>
                      <span>
                        Use the form to add the first
                        device.
                      </span>
                    </div>
                  )}
                </div>
              </section>
            </div>

            <aside className="inventory-forms">
              <form
                className="inventory-form"
                onSubmit={handleCreateSite}
              >
                <div className="inventory-form__heading">
                  <CirclePlus size={19} />
                  <div>
                    <strong>Add site</strong>
                    <small>
                      Create a monitored location.
                    </small>
                  </div>
                </div>

                <label>
                  Site name
                  <input
                    required
                    value={siteForm.name}
                    onChange={(event) =>
                      setSiteForm((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    placeholder="Deerfield Home Lab"
                  />
                </label>

                <label>
                  Site code
                  <input
                    required
                    value={siteForm.code}
                    onChange={(event) =>
                      setSiteForm((current) => ({
                        ...current,
                        code: event.target.value,
                      }))
                    }
                    placeholder="DEERFIELD-01"
                  />
                </label>

                <label>
                  Timezone
                  <input
                    value={siteForm.timezone}
                    onChange={(event) =>
                      setSiteForm((current) => ({
                        ...current,
                        timezone: event.target.value,
                      }))
                    }
                  />
                </label>

                <label>
                  Address
                  <input
                    value={siteForm.address}
                    onChange={(event) =>
                      setSiteForm((current) => ({
                        ...current,
                        address: event.target.value,
                      }))
                    }
                    placeholder="Optional"
                  />
                </label>

                <button
                  className="inventory-submit"
                  type="submit"
                  disabled={submitting !== null}
                >
                  {submitting === 'site' ? (
                    <LoaderCircle
                      className="spin"
                      size={17}
                    />
                  ) : (
                    <Building2 size={17} />
                  )}
                  Create site
                </button>
              </form>

              <form
                className="inventory-form"
                onSubmit={handleCreateDevice}
              >
                <div className="inventory-form__heading">
                  <CirclePlus size={19} />
                  <div>
                    <strong>Add equipment</strong>
                    <small>
                      Register a camera, DVR or device.
                    </small>
                  </div>
                </div>

                <label>
                  Site
                  <select
                    required
                    value={deviceForm.siteId}
                    onChange={(event) =>
                      setDeviceForm((current) => ({
                        ...current,
                        siteId: event.target.value,
                      }))
                    }
                  >
                    <option value="">
                      Select a site
                    </option>
                    {sites.map((site) => (
                      <option
                        key={site.id}
                        value={site.id}
                      >
                        {site.name} ({site.code})
                      </option>
                    ))}
                  </select>
                </label>

                <div className="inventory-form__row">
                  <label>
                    Name
                    <input
                      required
                      value={deviceForm.name}
                      onChange={(event) =>
                        setDeviceForm((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      placeholder="Garage Camera"
                    />
                  </label>

                  <label>
                    External ID
                    <input
                      required
                      value={deviceForm.externalId}
                      onChange={(event) =>
                        setDeviceForm((current) => ({
                          ...current,
                          externalId:
                            event.target.value,
                        }))
                      }
                      placeholder="CAM-002"
                    />
                  </label>
                </div>

                <label>
                  Equipment type
                  <select
                    value={deviceForm.deviceType}
                    onChange={(event) =>
                      setDeviceForm((current) => ({
                        ...current,
                        deviceType: event.target
                          .value as DeviceType,
                      }))
                    }
                  >
                    {deviceTypes.map((type) => (
                      <option
                        key={type.value}
                        value={type.value}
                      >
                        {type.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="inventory-form__row">
                  <label>
                    Manufacturer
                    <input
                      value={
                        deviceForm.manufacturer ?? ''
                      }
                      onChange={(event) =>
                        setDeviceForm((current) => ({
                          ...current,
                          manufacturer:
                            event.target.value,
                        }))
                      }
                      placeholder="Lorex"
                    />
                  </label>

                  <label>
                    Model
                    <input
                      value={deviceForm.model ?? ''}
                      onChange={(event) =>
                        setDeviceForm((current) => ({
                          ...current,
                          model: event.target.value,
                        }))
                      }
                      placeholder="L871T8-Z"
                    />
                  </label>
                </div>

                <div className="inventory-form__row">
                  <label>
                    IP address
                    <input
                      value={deviceForm.ipAddress ?? ''}
                      onChange={(event) =>
                        setDeviceForm((current) => ({
                          ...current,
                          ipAddress:
                            event.target.value,
                        }))
                      }
                      placeholder="192.168.1.50"
                    />
                  </label>

                  <label>
                    Serial number
                    <input
                      value={
                        deviceForm.serialNumber ?? ''
                      }
                      onChange={(event) =>
                        setDeviceForm((current) => ({
                          ...current,
                          serialNumber:
                            event.target.value,
                        }))
                      }
                      placeholder="Optional"
                    />
                  </label>
                </div>

                <label>
                  Heartbeat interval in seconds
                  <input
                    type="number"
                    min="5"
                    value={
                      deviceForm.expectedHeartbeatInterval
                    }
                    onChange={(event) =>
                      setDeviceForm((current) => ({
                        ...current,
                        expectedHeartbeatInterval:
                          Number(event.target.value),
                      }))
                    }
                  />
                </label>

                <button
                  className="inventory-submit"
                  type="submit"
                  disabled={
                    submitting !== null ||
                    sites.length === 0
                  }
                >
                  {submitting === 'device' ? (
                    <LoaderCircle
                      className="spin"
                      size={17}
                    />
                  ) : (
                    <Boxes size={17} />
                  )}
                  Create equipment
                </button>
              </form>
            </aside>
          </div>
        )}
      </section>

      {(editingSite || editingDevice) && (
        <InventoryEditPanel
          site={editingSite ?? undefined}
          device={editingDevice ?? undefined}
          sites={sites}
          onClose={() => {
            setEditingSite(null);
            setEditingDevice(null);
          }}
          onSaved={() => {
            setSuccess('Inventory updated successfully.');
            void loadInventory();
            onChanged();
          }}
        />
      )}
    </div>
  );
}
