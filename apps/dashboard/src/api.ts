import type {
  CreateDeviceInput,
  CreateSiteInput,
  DeviceAlert,
  DeviceConnectivityEventsResponse,
  FleetDevice,
  InventoryDevice,
  OperationsOverview,
  Site,
  TelemetryDemoState,
} from "./types";
import type {
  DeviceIngestionKeyStatus,
  RotatedDeviceIngestionKey,
} from "./types";

export interface AuthUser {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
  mustChangePassword: boolean;
  mfaEnabled: boolean;
}

export interface AuthenticatedLoginResponse {
  stage: "AUTHENTICATED";
  accessToken: string;
  user: AuthUser;
}

export interface PendingLoginResponse {
  stage: "PASSWORD_CHANGE_REQUIRED" | "MFA_REQUIRED";
  challengeToken: string;
  user: {
    name: string;
    email: string;
  };
}

export type LoginResponse = AuthenticatedLoginResponse | PendingLoginResponse;

export interface MfaStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodeCount: number;
  mustChangePassword: boolean;
}

export interface MfaSetup {
  secret: string;
  otpAuthUri: string;
}

export type ManagedUserRole = "ADMIN" | "OPERATOR" | "VIEWER";

export type ManagedUserStatus = "ACTIVE" | "DISABLED";

export type AuthSessionState = "ACTIVE" | "REVOKED" | "EXPIRED";

export interface AuthSession {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userRole: ManagedUserRole;
  userStatus: ManagedUserStatus;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  current: boolean;
  state: AuthSessionState;
}

export interface ManagedUser {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: ManagedUserRole;
  status: ManagedUserStatus;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  mfaEnabledAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  role: ManagedUserRole;
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
  role?: ManagedUserRole;
  status?: ManagedUserStatus;
}

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string): void {
  accessToken = token;
}

export function clearAccessToken(): void {
  accessToken = null;
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "/api/v1").replace(
  /\/$/,
  "",
);

function isPublicAuthenticationPath(path: string): boolean {
  return [
    "/auth/login",
    "/auth/refresh",
    "/auth/password/change",
    "/auth/mfa/verify",
  ].includes(path);
}

let refreshPromise: Promise<AuthenticatedLoginResponse> | null = null;

async function refreshAccessToken(): Promise<AuthenticatedLoginResponse> {
  if (!refreshPromise) {
    refreshPromise = fetch(`${apiBaseUrl}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Session refresh failed");
        }

        const result = (await response.json()) as AuthenticatedLoginResponse;

        setAccessToken(result.accessToken);

        return result;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

async function requestJson<T>(
  path: string,
  options: RequestInit = {},
  signal?: AbortSignal,
  allowRefresh = true,
): Promise<T> {
  const accessToken = getAccessToken();

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    signal,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : {}),
      ...(options.body
        ? {
            "Content-Type": "application/json",
          }
        : {}),
      ...options.headers,
    },
  });

  if (
    response.status === 401 &&
    allowRefresh &&
    !isPublicAuthenticationPath(path)
  ) {
    try {
      await refreshAccessToken();

      return requestJson<T>(path, options, signal, false);
    } catch {
      clearAccessToken();

      window.dispatchEvent(new Event("psop:unauthorized"));
    }
  }

  if (!response.ok) {
    if (
      response.status === 401 &&
      path !== "/auth/login" &&
      path !== "/auth/refresh"
    ) {
      clearAccessToken();

      window.dispatchEvent(new Event("psop:unauthorized"));
    }

    let message = `PSOP API returned HTTP ${response.status}`;

    try {
      const payload = (await response.json()) as {
        message?: string | string[];
      };

      if (Array.isArray(payload.message)) {
        message = payload.message.join(", ");
      } else if (payload.message) {
        message = payload.message;
      }
    } catch {
      message = `PSOP API returned HTTP ${response.status}`;
    }

    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export function getOperationsOverview(
  signal?: AbortSignal,
): Promise<OperationsOverview> {
  return requestJson<OperationsOverview>("/operations/overview", {}, signal);
}

export function evaluateFleetConnectivity(): Promise<{
  evaluatedAt: string;
  evaluatedDevices: number;
  createdEvents: number;
}> {
  return requestJson("/devices/telemetry/evaluate", {
    method: "POST",
  });
}

export function getDeviceIngestionKeyStatus(
  deviceId: string,
  signal?: AbortSignal,
): Promise<DeviceIngestionKeyStatus> {
  return requestJson<DeviceIngestionKeyStatus>(
    `/devices/${deviceId}/ingestion-key`,
    {},
    signal,
  );
}

export function rotateDeviceIngestionKey(
  deviceId: string,
): Promise<RotatedDeviceIngestionKey> {
  return requestJson<RotatedDeviceIngestionKey>(
    `/devices/${deviceId}/ingestion-key/rotate`,
    {
      method: "POST",
    },
  );
}

export function getTelemetryDemoStatus(signal?: AbortSignal): Promise<{
  enabled: boolean;
  states: TelemetryDemoState[];
  activeOverrides: number;
}> {
  return requestJson("/devices/demo/status", {}, signal);
}

export function setDeviceDemoState(
  deviceId: string,
  state: TelemetryDemoState,
): Promise<FleetDevice> {
  return requestJson(`/devices/${deviceId}/demo-state`, {
    method: "POST",
    body: JSON.stringify({
      state,
    }),
  });
}

export function getDeviceTelemetry(
  deviceId: string,
  signal?: AbortSignal,
): Promise<FleetDevice> {
  return requestJson<FleetDevice>(`/devices/${deviceId}/telemetry`, {}, signal);
}

export function getDeviceConnectivityEvents(
  deviceId: string,
  signal?: AbortSignal,
): Promise<DeviceConnectivityEventsResponse> {
  return requestJson<DeviceConnectivityEventsResponse>(
    `/devices/${deviceId}/connectivity-events`,
    {},
    signal,
  );
}

export function getDeviceAlerts(
  deviceId: string,
  signal?: AbortSignal,
): Promise<DeviceAlert[]> {
  return requestJson<DeviceAlert[]>(
    `/alerts?deviceId=${encodeURIComponent(deviceId)}`,
    {},
    signal,
  );
}

export function getSites(signal?: AbortSignal): Promise<Site[]> {
  return requestJson<Site[]>("/sites", {}, signal);
}

export function createSite(input: CreateSiteInput): Promise<Site> {
  return requestJson<Site>("/sites", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getDevices(signal?: AbortSignal): Promise<InventoryDevice[]> {
  return requestJson<InventoryDevice[]>("/devices", {}, signal);
}

export function createDevice(
  input: CreateDeviceInput,
): Promise<InventoryDevice> {
  return requestJson<InventoryDevice>("/devices", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteDevice(deviceId: string): Promise<InventoryDevice> {
  return requestJson<InventoryDevice>(`/devices/${deviceId}`, {
    method: "DELETE",
  });
}

export function updateSite(
  siteId: string,
  input: Partial<CreateSiteInput>,
): Promise<Site> {
  return requestJson<Site>(`/sites/${siteId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function updateDevice(
  deviceId: string,
  input: Partial<CreateDeviceInput>,
): Promise<InventoryDevice> {
  return requestJson<InventoryDevice>(`/devices/${deviceId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function getAlerts(
  status?: "OPEN" | "RESOLVED",
  signal?: AbortSignal,
): Promise<DeviceAlert[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";

  return requestJson<DeviceAlert[]>(`/alerts${query}`, {}, signal);
}

export function resolveAlert(alertId: string): Promise<DeviceAlert> {
  return requestJson<DeviceAlert>(`/alerts/${alertId}/resolve`, {
    method: "PATCH",
  });
}

export function login(email: string, password: string): Promise<LoginResponse> {
  return requestJson<LoginResponse>(
    "/auth/login",
    {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
      }),
    },
    undefined,
    false,
  );
}

export function getCurrentUser(signal?: AbortSignal): Promise<AuthUser> {
  return requestJson<AuthUser>("/auth/me", {}, signal);
}

export function getUsers(signal?: AbortSignal): Promise<ManagedUser[]> {
  return requestJson<ManagedUser[]>("/users", {}, signal);
}

export function createUser(input: CreateUserInput): Promise<ManagedUser> {
  return requestJson<ManagedUser>("/users", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateUser(
  userId: string,
  input: UpdateUserInput,
): Promise<ManagedUser> {
  return requestJson<ManagedUser>(`/users/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function changeUserPassword(
  userId: string,
  password: string,
): Promise<ManagedUser> {
  return requestJson<ManagedUser>(`/users/${userId}/password`, {
    method: "PATCH",
    body: JSON.stringify({ password }),
  });
}

export function deleteUser(userId: string): Promise<ManagedUser> {
  return requestJson<ManagedUser>(`/users/${userId}`, {
    method: "DELETE",
  });
}

export interface AuditLog {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  actorName: string;
  actorEmail: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string | null;
  method: string;
  path: string;
  statusCode: number;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: {
    durationMs?: number;
    request?: unknown;
    response?: unknown;
  } | null;
  createdAt: string;
}

export function getAuditLogs(
  limit = 100,
  signal?: AbortSignal,
): Promise<AuditLog[]> {
  return requestJson<AuditLog[]>(`/audit-logs?limit=${limit}`, {}, signal);
}

export function logoutCurrentSession(): Promise<{
  success: boolean;
}> {
  return requestJson("/auth/logout", {
    method: "POST",
  });
}

export function logoutAllCurrentSessions(): Promise<{
  success: boolean;
  revokedSessions: number;
}> {
  return requestJson("/auth/logout-all", {
    method: "POST",
  });
}

export function getAuthSessions(signal?: AbortSignal): Promise<AuthSession[]> {
  return requestJson<AuthSession[]>("/auth/sessions", {}, signal);
}

export function revokeAuthSession(sessionId: string): Promise<{
  success: boolean;
  revokedSessions: number;
}> {
  return requestJson(`/auth/sessions/${sessionId}`, {
    method: "DELETE",
  });
}

export function revokeUserAuthSessions(userId: string): Promise<{
  success: boolean;
  revokedSessions: number;
}> {
  return requestJson(`/auth/users/${userId}/sessions`, {
    method: "DELETE",
  });
}

export function completeFirstPasswordChange(
  challengeToken: string,
  newPassword: string,
): Promise<LoginResponse> {
  return requestJson<LoginResponse>(
    "/auth/password/change",
    {
      method: "POST",
      body: JSON.stringify({
        challengeToken,
        newPassword,
      }),
    },
    undefined,
    false,
  );
}

export function verifyMfaLogin(
  challengeToken: string,
  code: string,
): Promise<LoginResponse> {
  return requestJson<LoginResponse>(
    "/auth/mfa/verify",
    {
      method: "POST",
      body: JSON.stringify({
        challengeToken,
        code,
      }),
    },
    undefined,
    false,
  );
}

export function getMfaStatus(signal?: AbortSignal): Promise<MfaStatus> {
  return requestJson<MfaStatus>("/auth/mfa/status", {}, signal);
}

export function beginMfaSetup(): Promise<MfaSetup> {
  return requestJson<MfaSetup>("/auth/mfa/setup", {
    method: "POST",
  });
}

export function enableMfa(code: string): Promise<{
  enabled: boolean;
  recoveryCodes: string[];
}> {
  return requestJson("/auth/mfa/enable", {
    method: "POST",
    body: JSON.stringify({
      code,
    }),
  });
}

export function disableMfa(
  password: string,
  code: string,
): Promise<{
  enabled: boolean;
}> {
  return requestJson("/auth/mfa/disable", {
    method: "POST",
    body: JSON.stringify({
      password,
      code,
    }),
  });
}

export function regenerateMfaRecoveryCodes(
  password: string,
  code: string,
): Promise<{
  recoveryCodes: string[];
}> {
  return requestJson("/auth/mfa/recovery-codes", {
    method: "POST",
    body: JSON.stringify({
      password,
      code,
    }),
  });
}
