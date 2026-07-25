import type {
  CreateDeviceInput,
  CreateSiteInput,
  DeviceAlert,
  DeviceConnectivityEventsResponse,
  FleetDevice,
  InventoryDevice,
  OperationsOverview,
  Site,
} from './types';

export interface AuthUser {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER';
}

export interface LoginResponse {
  accessToken: string;
  user: AuthUser;
}

const ACCESS_TOKEN_KEY = 'psop.accessToken';

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function setAccessToken(token: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, token);
}

export function clearAccessToken(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
}

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL || '/api/v1'
).replace(/\/$/, '');

async function requestJson<T>(
  path: string,
  options: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const accessToken = getAccessToken();

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    signal,
    headers: {
      Accept: 'application/json',
      ...(accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : {}),
      ...(options.body
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    if (
      response.status === 401 &&
      path !== '/auth/login'
    ) {
      clearAccessToken();
      window.dispatchEvent(
        new Event('psop:unauthorized'),
      );
    }

    let message = `PSOP API returned HTTP ${response.status}`;

    try {
      const payload = (await response.json()) as {
        message?: string | string[];
      };

      if (Array.isArray(payload.message)) {
        message = payload.message.join(', ');
      } else if (payload.message) {
        message = payload.message;
      }
    } catch {
      // Preserve the HTTP fallback message.
    }

    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export function getOperationsOverview(
  signal?: AbortSignal,
): Promise<OperationsOverview> {
  return requestJson<OperationsOverview>(
    '/operations/overview',
    {},
    signal,
  );
}

export function getDeviceTelemetry(
  deviceId: string,
  signal?: AbortSignal,
): Promise<FleetDevice> {
  return requestJson<FleetDevice>(
    `/devices/${deviceId}/telemetry`,
    {},
    signal,
  );
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

export function getSites(
  signal?: AbortSignal,
): Promise<Site[]> {
  return requestJson<Site[]>('/sites', {}, signal);
}

export function createSite(
  input: CreateSiteInput,
): Promise<Site> {
  return requestJson<Site>('/sites', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getDevices(
  signal?: AbortSignal,
): Promise<InventoryDevice[]> {
  return requestJson<InventoryDevice[]>(
    '/devices',
    {},
    signal,
  );
}

export function createDevice(
  input: CreateDeviceInput,
): Promise<InventoryDevice> {
  return requestJson<InventoryDevice>('/devices', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteDevice(
  deviceId: string,
): Promise<InventoryDevice> {
  return requestJson<InventoryDevice>(
    `/devices/${deviceId}`,
    {
      method: 'DELETE',
    },
  );
}


export function updateSite(
  siteId: string,
  input: Partial<CreateSiteInput>,
): Promise<Site> {
  return requestJson<Site>(`/sites/${siteId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function updateDevice(
  deviceId: string,
  input: Partial<CreateDeviceInput>,
): Promise<InventoryDevice> {
  return requestJson<InventoryDevice>(
    `/devices/${deviceId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );
}


export function getAlerts(
  status?: 'OPEN' | 'RESOLVED',
  signal?: AbortSignal,
): Promise<DeviceAlert[]> {
  const query = status
    ? `?status=${encodeURIComponent(status)}`
    : '';

  return requestJson<DeviceAlert[]>(
    `/alerts${query}`,
    {},
    signal,
  );
}

export function resolveAlert(
  alertId: string,
): Promise<DeviceAlert> {
  return requestJson<DeviceAlert>(
    `/alerts/${alertId}/resolve`,
    {
      method: 'PATCH',
    },
  );
}


export function login(
  email: string,
  password: string,
): Promise<LoginResponse> {
  return requestJson<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
    }),
  });
}

export function getCurrentUser(
  signal?: AbortSignal,
): Promise<AuthUser> {
  return requestJson<AuthUser>('/auth/me', {}, signal);
}
