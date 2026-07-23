import type {
  DeviceAlert,
  DeviceConnectivityEventsResponse,
  FleetDevice,
  OperationsOverview,
} from './types';

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL || '/api/v1'
).replace(/\/$/, '');

async function requestJson<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    signal,
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `PSOP API returned HTTP ${response.status}`,
    );
  }

  return response.json() as Promise<T>;
}

export function getOperationsOverview(
  signal?: AbortSignal,
): Promise<OperationsOverview> {
  return requestJson<OperationsOverview>(
    '/operations/overview',
    signal,
  );
}

export function getDeviceTelemetry(
  deviceId: string,
  signal?: AbortSignal,
): Promise<FleetDevice> {
  return requestJson<FleetDevice>(
    `/devices/${deviceId}/telemetry`,
    signal,
  );
}

export function getDeviceConnectivityEvents(
  deviceId: string,
  signal?: AbortSignal,
): Promise<DeviceConnectivityEventsResponse> {
  return requestJson<DeviceConnectivityEventsResponse>(
    `/devices/${deviceId}/connectivity-events`,
    signal,
  );
}

export function getDeviceAlerts(
  deviceId: string,
  signal?: AbortSignal,
): Promise<DeviceAlert[]> {
  return requestJson<DeviceAlert[]>(
    `/alerts?deviceId=${encodeURIComponent(deviceId)}`,
    signal,
  );
}
