import { ArrowUpDown, Camera, HardDrive, Network, Search, Server, SlidersHorizontal } from 'lucide-react';
import type { ConnectivityState, FleetDevice, GatewayManagedDevice } from '../../types';

export type FleetStateFilter = ConnectivityState | 'ALL';
export type FleetSort = 'STATE' | 'NAME' | 'SITE' | 'HEARTBEAT';

const stateLabels: Record<ConnectivityState, string> = {
  ONLINE: 'Online', DEGRADED: 'Degraded', OFFLINE: 'Offline', NEVER_SEEN: 'Never seen', UNKNOWN: 'Unknown',
};

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return 'No heartbeat';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function DeviceIcon({ type }: { type: FleetDevice['device']['deviceType'] }) {
  if (type === 'CAMERA') return <Camera size={17} />;
  if (type === 'RECORDER') return <HardDrive size={17} />;
  if (type === 'GATEWAY') return <Network size={17} />;
  return <Server size={17} />;
}

function StatusBadge({ state }: { state: ConnectivityState }) {
  return <span className={`status-badge status-badge--${state.toLowerCase()}`}><span />{stateLabels[state]}</span>;
}

function verificationLabel(item: FleetDevice): string {
  return item.monitoring.individualVerification === 'RECORDER_VERIFIED'
    ? 'Recorder verified'
    : item.monitoring.individualVerification === 'DIRECT' ? 'Direct' : 'Not verified';
}

interface FilterToolbarProps {
  search: string;
  site: string;
  state: FleetStateFilter;
  sort: FleetSort;
  sites: Array<[string, string]>;
  hasFilters: boolean;
  onSearch: (value: string) => void;
  onSite: (value: string) => void;
  onState: (value: FleetStateFilter) => void;
  onSort: (value: FleetSort) => void;
  onClear: () => void;
}

export function FilterToolbar(props: FilterToolbarProps) {
  return (
    <div className="filter-toolbar">
      <label className="filter-search"><Search size={16} /><input value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="Search device, ID or site" /></label>
      <div className="filter-controls">
        <label className="filter-select"><SlidersHorizontal size={15} /><select aria-label="Filter by site" value={props.site} onChange={(event) => props.onSite(event.target.value)}><option value="ALL">All sites</option>{props.sites.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label className="filter-select"><select aria-label="Filter by state" value={props.state} onChange={(event) => props.onState(event.target.value as FleetStateFilter)}><option value="ALL">All states</option><option value="ONLINE">Online</option><option value="DEGRADED">Degraded</option><option value="OFFLINE">Offline</option><option value="UNKNOWN">Unknown</option><option value="NEVER_SEEN">Never seen</option></select></label>
        <label className="filter-select"><ArrowUpDown size={15} /><select aria-label="Sort fleet" value={props.sort} onChange={(event) => props.onSort(event.target.value as FleetSort)}><option value="STATE">Priority</option><option value="NAME">Device name</option><option value="SITE">Site</option><option value="HEARTBEAT">Heartbeat age</option></select></label>
        {props.hasFilters && <button className="filter-clear" type="button" onClick={props.onClear}>Clear</button>}
      </div>
    </div>
  );
}

function channelValue(item: FleetDevice): { primary: string; secondary: string } {
  const details = item.telemetry?.details;
  const number = (key: string) => typeof details?.[key] === 'number' ? details[key] as number : null;
  if (item.device.deviceType === 'RECORDER') {
    const online = number('onlineChannelCount');
    const observed = number('observedChannelCount');
    const used = number('poeUsedPowerW');
    const total = number('poeTotalPowerW');
    return {
      primary: online === null ? 'Recorder' : observed === null ? `${online} channels online` : `${online} / ${observed} channels`,
      secondary: total === null ? 'PoE not reported' : used === null ? `PoE ${total.toFixed(2)} W total` : `PoE ${used.toFixed(2)} / ${total.toFixed(2)} W`,
    };
  }
  return {
    primary: item.telemetry?.channelNumber == null ? 'Not applicable' : `Channel ${item.telemetry.channelNumber}`,
    secondary: item.telemetry?.poePowerW == null ? 'PoE not reported' : `PoE ${item.telemetry.poePowerW.toFixed(2)} W`,
  };
}

export function FleetTable({ items, onSelect }: { items: FleetDevice[]; onSelect: (id: string) => void }) {
  return (
    <div className="fleet-table-scroll">
      <table className="fleet-table">
        <colgroup>
          <col className="fleet-table__col--device" />
          <col className="fleet-table__col--state" />
          <col className="fleet-table__col--heartbeat" />
          <col className="fleet-table__col--site" />
          <col className="fleet-table__col--verification" />
          <col className="fleet-table__col--model" />
          <col className="fleet-table__col--channel" />
          <col className="fleet-table__col--protocol" />
          <col className="fleet-table__col--firmware" />
        </colgroup>
        <thead><tr><th>Device</th><th>State</th><th>Last heartbeat</th><th>Site</th><th>Verification</th><th>Model</th><th>Channel / PoE</th><th>Protocol</th><th>Firmware</th></tr></thead>
        <tbody>{items.map((item) => {
          const channel = channelValue(item);
          return <tr key={item.device.id} tabIndex={0} onClick={() => onSelect(item.device.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(item.device.id); } }}>
            <td><div className="fleet-device-cell"><span><DeviceIcon type={item.device.deviceType} /></span><div><strong>{item.device.name}</strong><small>{item.device.externalId}</small></div></div></td>
            <td><StatusBadge state={item.connectivity.state} /></td>
            <td><strong>{formatAge(item.connectivity.ageSeconds)}</strong><small>{formatDate(item.connectivity.lastHeartbeatAt)}</small></td>
            <td><strong>{item.device.siteName}</strong><small>{item.device.siteCode}</small></td>
            <td><strong>{verificationLabel(item)}</strong><small>{item.monitoring.source.replaceAll('_', ' ')}</small></td>
            <td><strong>{item.telemetry?.model || 'Not reported'}</strong></td>
            <td><strong>{channel.primary}</strong><small>{channel.secondary}</small></td>
            <td><code>{item.telemetry?.protocol || '—'}</code></td>
            <td><code title={item.telemetry?.firmware || 'Not reported'}>{item.telemetry?.firmware || '—'}</code></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  );
}

export function FleetMobileList({ items, onSelect }: { items: FleetDevice[]; onSelect: (id: string) => void }) {
  return <div className="fleet-mobile-list">{items.map((item) => <button key={item.device.id} type="button" onClick={() => onSelect(item.device.id)}>
    <span className="fleet-mobile-list__icon"><DeviceIcon type={item.device.deviceType} /></span>
    <span className="fleet-mobile-list__identity"><strong>{item.device.name}</strong><small>{item.device.siteName} · {item.device.externalId}</small><span>{formatAge(item.connectivity.ageSeconds)} · {verificationLabel(item)}</span></span>
    <StatusBadge state={item.connectivity.state} />
  </button>)}</div>;
}

function ManagedEquipment({ items, onSelect }: { items: GatewayManagedDevice[]; onSelect: (id: string) => void }) {
  if (items.length === 0) return null;
  return <section className="managed-equipment"><header><div><span className="eyebrow">Managed equipment</span><h3>Managed equipment</h3></div><span>{items.length} total</span></header><div>{items.map((item) => {
    const observed = item.monitoring.individualVerification === 'RECORDER_VERIFIED' && item.connectivity ? item.connectivity.state : item.gateway.connectivity.state;
    return <button key={item.device.id} type="button" onClick={() => onSelect(item.device.id)}><span className="fleet-mobile-list__icon"><DeviceIcon type={item.device.deviceType} /></span><span><strong>{item.device.name}</strong><small>{item.monitoring.individualVerification === 'RECORDER_VERIFIED' ? `Verified by ${item.gateway.name}` : `Derived from ${item.gateway.name}`}</small></span><StatusBadge state={observed} /></button>;
  })}</div></section>;
}

interface FleetWorkspaceProps extends FilterToolbarProps {
  items: FleetDevice[];
  total: number;
  managed: GatewayManagedDevice[];
  onSelect: (id: string) => void;
}

export default function FleetWorkspace(props: FleetWorkspaceProps) {
  return <section className="fleet-workspace" aria-labelledby="fleet-title">
    <header className="fleet-workspace__header"><div><span className="eyebrow">Fleet workspace</span><h2 id="fleet-title">Monitored fleet</h2></div><span>{props.items.length === props.total ? `${props.total} devices` : `${props.items.length} of ${props.total}`}</span></header>
    <FilterToolbar {...props} />
    {props.items.length > 0 ? <><FleetTable items={props.items} onSelect={props.onSelect} /><FleetMobileList items={props.items} onSelect={props.onSelect} /></> : <div className="fleet-empty"><Server size={23} /><strong>No devices match the current filters</strong><span>Adjust the search or clear the selected conditions.</span></div>}
    <ManagedEquipment items={props.managed} onSelect={props.onSelect} />
  </section>;
}
