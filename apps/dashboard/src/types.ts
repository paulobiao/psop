export type ConnectivityState =
  | 'ONLINE'
  | 'OFFLINE'
  | 'NEVER_SEEN'
  | 'UNKNOWN';

export type AlertSeverity = 'CRITICAL' | 'WARNING';

export interface OperationsSummary {
  sites: number;
  cameras: number;
  online: number;
  offline: number;
  neverSeen: number;
  unknown: number;
  activeAlerts: number;
  criticalAlerts: number;
  warningAlerts: number;
}

export interface FleetDevice {
  device: {
    id: string;
    name: string;
    externalId: string;
    deviceType: string;
    administrativeStatus: string;
    siteId: string;
    siteCode: string;
    siteName: string;
  };
  connectivity: {
    state: ConnectivityState;
    lastHeartbeatAt: string | null;
    ageSeconds: number | null;
    expectedHeartbeatIntervalSeconds: number;
    offlineAfterSeconds: number;
  };
  telemetry: {
    reportedStatus: string | null;
    temperatureC: number | null;
    bitrateKbps: number | null;
    storageUsedPct: number | null;
    uptimeSeconds: number | null;
    model: string | null;
    firmware: string | null;
    isoTime: string | null;
  } | null;
}

export interface ActiveAlert {
  id: string;
  deviceId: string;
  deviceName: string;
  externalId: string;
  siteCode: string;
  siteName: string;
  type: string;
  status: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  connectivityState: string | null;
  openedAt: string;
  lastDetectedAt: string;
}

export interface ConnectivityEvent {
  camera_id: string;
  timestamp: number;
  event_type: string;
  device_id: string;
  device_name: string;
  site_id: string;
  external_id: string;
  previous_state: ConnectivityState | null;
  current_state: ConnectivityState;
  detected_at: string;
  last_heartbeat_at: string | null;
  age_seconds: number | null;
}

export interface OperationsOverview {
  generatedAt: string;
  summary: OperationsSummary;
  fleet: FleetDevice[];
  activeAlerts: ActiveAlert[];
  recentEvents: ConnectivityEvent[];
}


export interface DeviceConnectivityEventsResponse {
  device: {
    id: string;
    name: string;
    externalId: string;
    siteId: string;
    siteCode: string;
    siteName: string;
  };
  events: ConnectivityEvent[];
}

export interface DeviceAlert {
  id: string;
  deviceId: string;
  type: string;
  status: 'OPEN' | 'RESOLVED';
  severity: AlertSeverity;
  title: string;
  message: string;
  connectivityState: string | null;
  openedAt: string;
  lastDetectedAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  device?: {
    id: string;
    name: string;
    externalId: string;
    deviceType: string;
    site: {
      id: string;
      name: string;
      code: string;
    };
  };
}


export type DeviceType =
  | 'CAMERA'
  | 'RECORDER'
  | 'GATEWAY'
  | 'ACCESS_CONTROLLER'
  | 'SENSOR'
  | 'INTERCOM'
  | 'NETWORK_SWITCH';

export interface Site {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  timezone: string | null;
  address: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface InventoryDevice {
  id: string;
  siteId: string;
  name: string;
  externalId: string;
  deviceType: DeviceType;
  manufacturer: string | null;
  model: string | null;
  firmwareVersion: string | null;
  ipAddress: string | null;
  serialNumber: string | null;
  status: string;
  expectedHeartbeatInterval: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateSiteInput {
  organizationId: string;
  name: string;
  code: string;
  timezone?: string;
  address?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE' | 'ARCHIVED';
}

export interface CreateDeviceInput {
  siteId: string;
  name: string;
  externalId: string;
  deviceType: DeviceType;
  manufacturer?: string;
  model?: string;
  firmwareVersion?: string;
  ipAddress?: string;
  serialNumber?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE' | 'DECOMMISSIONED';
  expectedHeartbeatInterval?: number;
}
