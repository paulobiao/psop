export type ConnectivityState =
  "ONLINE" | "DEGRADED" | "OFFLINE" | "NEVER_SEEN" | "UNKNOWN";

export type AlertSeverity = "CRITICAL" | "WARNING";

export type TelemetryDemoState = ConnectivityState;

export interface DeviceIngestionKeyStatus {
  enabled: boolean;
  configured: boolean;
  keyPrefix: string | null;
  rotatedAt: string | null;
}

export interface RotatedDeviceIngestionKey extends DeviceIngestionKeyStatus {
  deviceId: string;
  externalId: string;
  deviceKey: string;
}

export interface OperationsSummary {
  sites: number;
  cameras: number;
  gatewayManaged: number;
  online: number;
  degraded: number;
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
    deviceType: DeviceType;
    monitoringMode: DeviceMonitoringMode;
    gatewayDeviceId: string | null;
    administrativeStatus: string;
    siteId: string;
    siteCode: string;
    siteName: string;
  };
  connectivity: {
    state: ConnectivityState;
    reasons: string[];
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

export interface GatewayManagedDevice {
  device: {
    id: string;
    name: string;
    externalId: string;
    deviceType: DeviceType;
    administrativeStatus: string;
    siteId: string;
    siteCode: string;
    siteName: string;
  };
  monitoring: {
    source: "GATEWAY_DERIVED";
    individualVerification: "NOT_VERIFIED";
  };
  gateway: {
    id: string;
    name: string;
    externalId: string;
    deviceType: DeviceType;
    connectivity: {
      state: ConnectivityState;
      reasons: string[];
      lastHeartbeatAt: string | null;
      ageSeconds: number | null;
      expectedHeartbeatIntervalSeconds: number;
      offlineAfterSeconds: number;
    };
  };
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

export interface OperationalIncident {
  id: string;
  deviceId: string;
  deviceName: string;
  externalId: string;
  deviceType: DeviceType;
  siteId: string;
  siteCode: string;
  siteName: string;
  status: "OPEN" | "RESOLVED";
  severity: AlertSeverity;
  title: string;
  message: string;
  terminalConnectivityState: string | null;
  monitoringSource: "DIRECT";
  startedAt: string;
  endedAt: string | null;
  lastDetectedAt: string;
  durationSeconds: number;
}

export interface EdgeAgentRuntime {
  device: {
    id: string;
    name: string;
    externalId: string;
    deviceType: DeviceType;
    siteId: string;
    siteCode: string;
    siteName: string;
  };
  runtime: {
    agentVersion: string;
    runtimeStartedAt: string;
    uptimeSeconds: number;
    deliveryState:
      | "DELIVERED"
      | "BUFFERED"
      | "ERROR";
    previousDeliveryState:
      | "DELIVERED"
      | "BUFFERED"
      | "ERROR"
      | null;
    pendingBufferCount: number;
    lastSuccessfulDeliveryAt:
      | string
      | null;
    lastDeliveryError: string | null;
    lastDeliveryErrorAt: string | null;
  };
  report: {
    receivedAt: string;
    ageSeconds: number;
    freshness: "REPORTING" | "STALE";
  };
  connectivity: FleetDevice["connectivity"] | null;
}

export interface IncidentAnalytics {
  activeCount: number;
  recoveredCount: number;
  recoveredLast24h: number;
  meanRecoverySeconds: number | null;
  longestRecentIncidentSeconds:
    | number
    | null;
  longestRecentIncidentId:
    | string
    | null;
  recoverySampleCount: number;
  recoveryWindowDays: number;
}

export interface OperationsOverview {
  generatedAt: string;
  summary: OperationsSummary;
  fleet: FleetDevice[];
  gatewayManaged: GatewayManagedDevice[];
  edgeAgents: EdgeAgentRuntime[];
  incidentAnalytics: IncidentAnalytics;
  activeAlerts: ActiveAlert[];
  recentEvents: ConnectivityEvent[];
  recentIncidents: OperationalIncident[];
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
  status: "OPEN" | "RESOLVED";
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

export type DeviceMonitoringMode =
  | "DIRECT"
  | "VIA_GATEWAY"
  | "INVENTORY_ONLY";

export type DeviceType =
  | "CAMERA"
  | "RECORDER"
  | "GATEWAY"
  | "ACCESS_CONTROLLER"
  | "SENSOR"
  | "INTERCOM"
  | "NETWORK_SWITCH";

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
  monitoringMode: DeviceMonitoringMode;
  gatewayDeviceId: string | null;
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
  name: string;
  code: string;
  timezone?: string;
  address?: string;
  status?: "ACTIVE" | "INACTIVE" | "MAINTENANCE" | "ARCHIVED";
}

export interface CreateDeviceInput {
  siteId: string;
  name: string;
  externalId: string;
  deviceType: DeviceType;
  monitoringMode?: DeviceMonitoringMode;
  gatewayDeviceId?: string | null;
  manufacturer?: string;
  model?: string;
  firmwareVersion?: string;
  ipAddress?: string;
  serialNumber?: string;
  status?: "ACTIVE" | "INACTIVE" | "MAINTENANCE" | "DECOMMISSIONED";
  expectedHeartbeatInterval?: number;
}

export interface NotificationPolicy {
  id: string | null;
  organizationId: string;
  enabled: boolean;
  minimumSeverity: AlertSeverity;
  notifyOnRecovery: boolean;
  notifyAdmins: boolean;
  notifyOperators: boolean;
  explicitEmails: string[];
  cooldownMinutes: number;
  escalationDelayMinutes: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface NotificationTransportStatus {
  channel: "EMAIL";
  configured: boolean;
  hostConfigured: boolean;
  fromConfigured: boolean;
  authentication:
    | "AUTHENTICATED"
    | "NONE"
    | "INCOMPLETE";
  secure: boolean;
  port: number;
}

export type NotificationDeliveryStatus =
  | "PENDING"
  | "SENT"
  | "FAILED"
  | "SKIPPED_NOT_CONFIGURED"
  | "SKIPPED_COOLDOWN"
  | "SKIPPED_POLICY";

export interface NotificationDelivery {
  id: string;
  alertId: string;
  eventType:
    | "INCIDENT_OPENED"
    | "INCIDENT_RECOVERED";
  channel: "EMAIL";
  recipientEmail: string;
  recipientSource: string;
  status: NotificationDeliveryStatus;
  subject: string;
  eligibleAt: string;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  incident: {
    id: string;
    severity: AlertSeverity;
    status: "OPEN" | "RESOLVED";
    connectivityState: string | null;
    openedAt: string;
    resolvedAt: string | null;
  };
  device: {
    id: string;
    name: string;
    externalId: string;
    siteId: string;
    siteCode: string;
    siteName: string;
  };
}

export interface UpdateNotificationPolicyInput {
  enabled?: boolean;
  minimumSeverity?: AlertSeverity;
  notifyOnRecovery?: boolean;
  notifyAdmins?: boolean;
  notifyOperators?: boolean;
  explicitEmails?: string[];
  cooldownMinutes?: number;
  escalationDelayMinutes?: number;
}
