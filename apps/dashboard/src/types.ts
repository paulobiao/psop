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
