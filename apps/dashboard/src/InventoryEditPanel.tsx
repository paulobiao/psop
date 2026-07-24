import {
  Building2,
  Boxes,
  LoaderCircle,
  Save,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  useEffect,
  useState,
} from 'react';
import {
  updateDevice,
  updateSite,
} from './api';
import type {
  DeviceType,
  InventoryDevice,
  Site,
} from './types';

interface InventoryEditPanelProps {
  site?: Site;
  device?: InventoryDevice;
  sites: Site[];
  onClose: () => void;
  onSaved: () => void;
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

export default function InventoryEditPanel({
  site,
  device,
  sites,
  onClose,
  onSaved,
}: InventoryEditPanelProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [siteForm, setSiteForm] = useState({
    name: site?.name ?? '',
    code: site?.code ?? '',
    timezone: site?.timezone ?? '',
    address: site?.address ?? '',
    status:
      (site?.status as
        | 'ACTIVE'
        | 'INACTIVE'
        | 'MAINTENANCE'
        | 'ARCHIVED') ?? 'ACTIVE',
  });

  const [deviceForm, setDeviceForm] = useState({
    siteId: device?.siteId ?? '',
    name: device?.name ?? '',
    externalId: device?.externalId ?? '',
    deviceType:
      device?.deviceType ?? ('CAMERA' as DeviceType),
    manufacturer: device?.manufacturer ?? '',
    model: device?.model ?? '',
    firmwareVersion: device?.firmwareVersion ?? '',
    ipAddress: device?.ipAddress ?? '',
    serialNumber: device?.serialNumber ?? '',
    status:
      (device?.status as
        | 'ACTIVE'
        | 'INACTIVE'
        | 'MAINTENANCE'
        | 'DECOMMISSIONED') ?? 'ACTIVE',
    expectedHeartbeatInterval:
      device?.expectedHeartbeatInterval ?? 60,
  });

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

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      if (site) {
        await updateSite(site.id, {
          name: siteForm.name.trim(),
          code: siteForm.code.trim().toUpperCase(),
          timezone:
            siteForm.timezone.trim() || undefined,
          address: siteForm.address.trim() || undefined,
          status: siteForm.status,
        });
      }

      if (device) {
        await updateDevice(device.id, {
          siteId: deviceForm.siteId,
          name: deviceForm.name.trim(),
          externalId: deviceForm.externalId.trim(),
          deviceType: deviceForm.deviceType,
          manufacturer:
            deviceForm.manufacturer.trim() || undefined,
          model: deviceForm.model.trim() || undefined,
          firmwareVersion:
            deviceForm.firmwareVersion.trim() ||
            undefined,
          ipAddress:
            deviceForm.ipAddress.trim() || undefined,
          serialNumber:
            deviceForm.serialNumber.trim() || undefined,
          status: deviceForm.status,
          expectedHeartbeatInterval:
            deviceForm.expectedHeartbeatInterval,
        });
      }

      onSaved();
      onClose();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to update inventory',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="inventory-edit-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="inventory-edit-panel"
        role="dialog"
        aria-modal="true"
        aria-label={
          site ? 'Edit site' : 'Edit equipment'
        }
      >
        <header className="inventory-edit-header">
          <div className="inventory-edit-title">
            <span className="inventory-edit-title__icon">
              {site ? (
                <Building2 size={20} />
              ) : (
                <Boxes size={20} />
              )}
            </span>

            <div>
              <span className="eyebrow">
                Inventory administration
              </span>
              <h2>
                {site
                  ? `Edit ${site.name}`
                  : `Edit ${device?.name}`}
              </h2>
            </div>
          </div>

          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close editor"
          >
            <X size={20} />
          </button>
        </header>

        {error && (
          <div className="inventory-message inventory-message--error">
            {error}
          </div>
        )}

        <form
          className="inventory-edit-form"
          onSubmit={handleSubmit}
        >
          {site && (
            <>
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
                />
              </label>

              <label>
                Status
                <select
                  value={siteForm.status}
                  onChange={(event) =>
                    setSiteForm((current) => ({
                      ...current,
                      status: event.target.value as
                        | 'ACTIVE'
                        | 'INACTIVE'
                        | 'MAINTENANCE'
                        | 'ARCHIVED',
                    }))
                  }
                >
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">
                    Inactive
                  </option>
                  <option value="MAINTENANCE">
                    Maintenance
                  </option>
                  <option value="ARCHIVED">
                    Archived
                  </option>
                </select>
              </label>
            </>
          )}

          {device && (
            <>
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
                  {sites.map((item) => (
                    <option
                      key={item.id}
                      value={item.id}
                    >
                      {item.name} ({item.code})
                    </option>
                  ))}
                </select>
              </label>

              <div className="inventory-edit-row">
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

              <div className="inventory-edit-row">
                <label>
                  Manufacturer
                  <input
                    value={deviceForm.manufacturer}
                    onChange={(event) =>
                      setDeviceForm((current) => ({
                        ...current,
                        manufacturer:
                          event.target.value,
                      }))
                    }
                  />
                </label>

                <label>
                  Model
                  <input
                    value={deviceForm.model}
                    onChange={(event) =>
                      setDeviceForm((current) => ({
                        ...current,
                        model: event.target.value,
                      }))
                    }
                  />
                </label>
              </div>

              <div className="inventory-edit-row">
                <label>
                  Firmware
                  <input
                    value={deviceForm.firmwareVersion}
                    onChange={(event) =>
                      setDeviceForm((current) => ({
                        ...current,
                        firmwareVersion:
                          event.target.value,
                      }))
                    }
                  />
                </label>

                <label>
                  IP address
                  <input
                    value={deviceForm.ipAddress}
                    onChange={(event) =>
                      setDeviceForm((current) => ({
                        ...current,
                        ipAddress:
                          event.target.value,
                      }))
                    }
                  />
                </label>
              </div>

              <label>
                Serial number
                <input
                  value={deviceForm.serialNumber}
                  onChange={(event) =>
                    setDeviceForm((current) => ({
                      ...current,
                      serialNumber:
                        event.target.value,
                    }))
                  }
                />
              </label>

              <div className="inventory-edit-row">
                <label>
                  Status
                  <select
                    value={deviceForm.status}
                    onChange={(event) =>
                      setDeviceForm((current) => ({
                        ...current,
                        status: event.target.value as
                          | 'ACTIVE'
                          | 'INACTIVE'
                          | 'MAINTENANCE'
                          | 'DECOMMISSIONED',
                      }))
                    }
                  >
                    <option value="ACTIVE">
                      Active
                    </option>
                    <option value="INACTIVE">
                      Inactive
                    </option>
                    <option value="MAINTENANCE">
                      Maintenance
                    </option>
                    <option value="DECOMMISSIONED">
                      Decommissioned
                    </option>
                  </select>
                </label>

                <label>
                  Heartbeat interval
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
              </div>
            </>
          )}

          <div className="inventory-edit-actions">
            <button
              type="button"
              className="inventory-edit-cancel"
              onClick={onClose}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="inventory-submit inventory-submit--edit"
              disabled={saving}
            >
              {saving ? (
                <LoaderCircle
                  className="spin"
                  size={17}
                />
              ) : (
                <Save size={17} />
              )}
              Save changes
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
