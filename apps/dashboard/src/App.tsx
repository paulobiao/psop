import { AlertTriangle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { evaluateFleetConnectivity, getOperationsOverview } from './api';
import AlertManagementPanel from './AlertManagementPanel';
import AuditLogPanel from './AuditLogPanel';
import DeviceDetailsPanel from './DeviceDetailsPanel';
import GatewayOperationsPanel from './GatewayOperationsPanel';
import IncidentHistoryPanel from './IncidentHistoryPanel';
import InventoryPanel from './InventoryPanel';
import NotificationSettingsPanel from './NotificationSettingsPanel';
import SessionManagementPanel from './SessionManagementPanel';
import SiteDetailsPanel from './SiteDetailsPanel';
import UserManagementPanel from './UserManagementPanel';
import { useAuthUser } from './AuthGate';
import { Fleet, Incidents, Priorities, Rail, Sidebar, Topbar, Topology, type FleetSort, type FleetStateFilter, type NavActions } from './components/lovable/LovableShell';
import type { ConnectivityState, OperationsOverview } from './types';

const REFRESH_INTERVAL_MS = 15_000;
const connectivityOrder: Record<ConnectivityState, number> = { OFFLINE: 0, DEGRADED: 1, NEVER_SEEN: 2, UNKNOWN: 3, ONLINE: 4 };

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function LoadingState() {
  return <div className="loading-state"><strong>Loading security operations…</strong><span>Connecting to the PSOP API</span></div>;
}

export default function App() {
  const authUser = useAuthUser();
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [alertManagementOpen, setAlertManagementOpen] = useState(false);
  const [incidentHistoryOpen, setIncidentHistoryOpen] = useState(false);
  const [gatewayOperationsOpen, setGatewayOperationsOpen] = useState(false);
  const [userManagementOpen, setUserManagementOpen] = useState(false);
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false);
  const [auditLogOpen, setAuditLogOpen] = useState(false);
  const [sessionManagementOpen, setSessionManagementOpen] = useState(false);
  const [siteDetailsOpen, setSiteDetailsOpen] = useState(false);
  const [fleetSearch, setFleetSearch] = useState('');
  const [fleetSite, setFleetSite] = useState('ALL');
  const [fleetState, setFleetState] = useState<FleetStateFilter>('ALL');
  const [fleetSort, setFleetSort] = useState<FleetSort>('STATE');

  const loadOverview = useCallback(async (silent = false) => {
    const controller = new AbortController();
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      setOverview(await getOperationsOverview(controller.signal));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load PSOP operations');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    return () => controller.abort();
  }, []);

  useEffect(() => {
    void loadOverview();
    const interval = window.setInterval(() => void loadOverview(true), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadOverview]);

  const fleetSites = useMemo(() => {
    const sites = new Map<string, string>();
    overview?.fleet.forEach((item) => sites.set(item.device.siteId, `${item.device.siteName} (${item.device.siteCode})`));
    return Array.from(sites.entries()).sort(([, first], [, second]) => first.localeCompare(second));
  }, [overview]);

  const filteredFleet = useMemo(() => {
    if (!overview) return [];
    const search = fleetSearch.trim().toLowerCase();
    return overview.fleet.filter((item) => {
      const matchesSearch = !search || [item.device.name, item.device.externalId, item.device.siteName, item.device.siteCode].join(' ').toLowerCase().includes(search);
      return matchesSearch && (fleetSite === 'ALL' || item.device.siteId === fleetSite) && (fleetState === 'ALL' || item.connectivity.state === fleetState);
    }).sort((first, second) => {
      if (fleetSort === 'NAME') return first.device.name.localeCompare(second.device.name);
      if (fleetSort === 'SITE') return first.device.siteName.localeCompare(second.device.siteName) || first.device.name.localeCompare(second.device.name);
      if (fleetSort === 'HEARTBEAT') return (second.connectivity.ageSeconds ?? -1) - (first.connectivity.ageSeconds ?? -1);
      return connectivityOrder[first.connectivity.state] - connectivityOrder[second.connectivity.state] || first.device.name.localeCompare(second.device.name);
    });
  }, [overview, fleetSearch, fleetSite, fleetState, fleetSort]);

  const hasFleetFilters = fleetSearch.trim() !== '' || fleetSite !== 'ALL' || fleetState !== 'ALL' || fleetSort !== 'STATE';
  const healthLabel = useMemo(() => {
    if (!overview) return 'Connecting';
    if (overview.summary.offline > 0 || overview.summary.criticalAlerts > 0) return 'Attention required';
    if (overview.summary.degraded > 0 || overview.summary.warningAlerts > 0 || overview.summary.neverSeen > 0 || overview.summary.unknown > 0) return 'Review recommended';
    return 'All systems operational';
  }, [overview]);
  const healthTone = !overview ? 'connecting' as const : overview.summary.offline > 0 || overview.summary.criticalAlerts > 0 ? 'critical' as const : overview.summary.degraded > 0 || overview.summary.warningAlerts > 0 || overview.summary.neverSeen > 0 || overview.summary.unknown > 0 ? 'warning' as const : 'healthy' as const;

  const evaluate = () => {
    setEvaluating(true);
    setError(null);
    void evaluateFleetConnectivity().then(() => loadOverview(true)).catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Unable to evaluate fleet connectivity')).finally(() => setEvaluating(false));
  };
  const clearFilters = () => { setFleetSearch(''); setFleetSite('ALL'); setFleetState('ALL'); setFleetSort('STATE'); };
  const navigationActions: NavActions = {
    alerts: () => setAlertManagementOpen(true), incidents: () => setIncidentHistoryOpen(true), agents: () => setGatewayOperationsOpen(true),
    sites: () => setSiteDetailsOpen(true), inventory: () => setInventoryOpen(true), sessions: () => setSessionManagementOpen(true),
    audit: () => setAuditLogOpen(true), users: () => setUserManagementOpen(true), notifications: () => setNotificationSettingsOpen(true),
  };

  if (loading && !overview) return <LoadingState />;

  return <div className="flex min-h-screen bg-background text-foreground">
    <Sidebar role={authUser.role} userName={authUser.name} alertCount={overview?.summary.activeAlerts ?? 0} actions={navigationActions} />
    <main className="min-w-0 flex-1">
      {error && <div className="m-5 flex items-center gap-2 rounded-xl border border-critical/40 bg-critical/10 p-3 text-sm text-critical"><AlertTriangle size={18} /><span>{error}</span></div>}
      {overview && <>
        <Topbar summary={overview.summary} siteName={overview.fleet[0]?.device.siteName ?? 'All monitored sites'} siteCode={overview.fleet[0]?.device.siteCode ?? 'FLEET'} generatedAt={overview.generatedAt} healthLabel={healthLabel} healthTone={healthTone} refreshing={refreshing} evaluating={evaluating} canEvaluate={authUser.role !== 'VIEWER'} onRefresh={() => void loadOverview(true)} onEvaluate={evaluate} />
        <div className="space-y-5 p-5">
          <Priorities summary={overview.summary} selected={fleetState} onSelect={setFleetState} onAlerts={() => setAlertManagementOpen(true)} />
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-5">
              <Topology fleet={overview.fleet} managed={overview.gatewayManaged} onSelect={setSelectedDeviceId} />
              <Fleet items={filteredFleet} total={overview.fleet.length} managed={overview.gatewayManaged} search={fleetSearch} site={fleetSite} state={fleetState} sort={fleetSort} sites={fleetSites} hasFilters={hasFleetFilters} onSearch={setFleetSearch} onSite={setFleetSite} onState={setFleetState} onSort={setFleetSort} onClear={clearFilters} onSelect={setSelectedDeviceId} />
              <Incidents items={overview.recentIncidents ?? []} onOpen={() => setIncidentHistoryOpen(true)} />
            </div>
            <Rail alerts={overview.activeAlerts} events={overview.recentEvents} onOpenAlerts={() => setAlertManagementOpen(true)} />
          </div>
        </div>
      </>}
    </main>

    {sessionManagementOpen && <SessionManagementPanel onClose={() => setSessionManagementOpen(false)} />}
    {auditLogOpen && <AuditLogPanel onClose={() => setAuditLogOpen(false)} />}
    {userManagementOpen && <UserManagementPanel currentUserId={authUser.id} onClose={() => setUserManagementOpen(false)} />}
    {notificationSettingsOpen && <NotificationSettingsPanel onClose={() => setNotificationSettingsOpen(false)} />}
    {siteDetailsOpen && <SiteDetailsPanel onClose={() => setSiteDetailsOpen(false)} onSelectDevice={(deviceId) => { setSiteDetailsOpen(false); setSelectedDeviceId(deviceId); }} />}
    {gatewayOperationsOpen && overview && <GatewayOperationsPanel agents={overview.edgeAgents ?? []} generatedAt={overview.generatedAt} refreshing={refreshing} onRefresh={() => void loadOverview(true)} onClose={() => setGatewayOperationsOpen(false)} />}
    {incidentHistoryOpen && overview && <IncidentHistoryPanel incidents={overview.recentIncidents ?? []} analytics={overview.incidentAnalytics} generatedAt={overview.generatedAt} refreshing={refreshing} onRefresh={() => void loadOverview(true)} onClose={() => setIncidentHistoryOpen(false)} />}
    {alertManagementOpen && <AlertManagementPanel onClose={() => setAlertManagementOpen(false)} onChanged={() => void loadOverview(true)} />}
    {inventoryOpen && <InventoryPanel onClose={() => setInventoryOpen(false)} onChanged={() => void loadOverview(true)} />}
    {selectedDeviceId && <DeviceDetailsPanel deviceId={selectedDeviceId} onClose={() => setSelectedDeviceId(null)} onChanged={() => void loadOverview(true)} />}
  </div>;
}
