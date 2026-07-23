import type { OperationsOverview } from './types';

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL || '/api/v1'
).replace(/\/$/, '');

export async function getOperationsOverview(
  signal?: AbortSignal,
): Promise<OperationsOverview> {
  const response = await fetch(
    `${apiBaseUrl}/operations/overview`,
    {
      signal,
      headers: {
        Accept: 'application/json',
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `PSOP API returned HTTP ${response.status}`,
    );
  }

  return response.json() as Promise<OperationsOverview>;
}
