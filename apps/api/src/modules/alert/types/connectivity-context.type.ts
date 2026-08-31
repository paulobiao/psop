export interface ConnectivityContext {
  reasons: string[];
  monitoringSource: string;
  individualVerification: string;
  observerDeviceId: string | null;
  observerDeviceName: string | null;
  channelId: string | null;
  channelNumber: number | null;
  lastHeartbeatAt: string | null;
  ageSeconds: number | null;

  // --- Operational Health Engine V2 (optional / additive) ---
  /**
   * Which dimension drove this incident. CONNECTIVITY = the device is not
   * reachable / observed; HEALTH = the device is reachable but operationally
   * degraded (temperature, storage, ...).
   */
  dimension?: 'CONNECTIVITY' | 'HEALTH';
  /** True connectivity dimension (ONLINE/OFFLINE/UNKNOWN/NEVER_SEEN). */
  linkState?: string;
  /** Health dimension state at detection time. */
  healthState?: string;
  /** Structured health reasons at detection time. */
  healthReasons?: string[];
  /** Collection-quality snapshot — diagnostics only, never opens an incident. */
  collectionState?: string;
  collectionIssues?: string[];
}
