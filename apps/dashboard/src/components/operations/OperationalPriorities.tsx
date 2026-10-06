import { AlertTriangle, Database, ShieldAlert, WifiOff } from 'lucide-react';
import type { ConnectivityState, OperationsSummary } from '../../types';

interface OperationalPrioritiesProps {
  summary: OperationsSummary;
  activeFilter: ConnectivityState | 'ALL';
  onFilter: (state: ConnectivityState) => void;
  onAlerts: () => void;
}

export default function OperationalPriorities({ summary, activeFilter, onFilter, onAlerts }: OperationalPrioritiesProps) {
  return (
    <section className="priority-section" aria-labelledby="priority-title">
      <div className="workspace-section-heading">
        <div><span className="eyebrow">Operational priorities</span><h2 id="priority-title">Requires attention</h2></div>
        <span>Select a condition to focus the fleet</span>
      </div>
      <div className="priority-grid">
        <button className={`priority-item priority-item--offline${activeFilter === 'OFFLINE' ? ' is-selected' : ''}`} type="button" onClick={() => onFilter('OFFLINE')}>
          <span className="priority-item__label">Offline</span><WifiOff size={18} /><strong>{summary.offline}</strong><small>Heartbeat overdue</small>
        </button>
        <button className={`priority-item priority-item--degraded${activeFilter === 'DEGRADED' ? ' is-selected' : ''}`} type="button" onClick={() => onFilter('DEGRADED')}>
          <span className="priority-item__label">Degraded</span><AlertTriangle size={18} /><strong>{summary.degraded}</strong><small>Reporting with warnings</small>
        </button>
        <button className="priority-item priority-item--critical" type="button" onClick={onAlerts}>
          <span className="priority-item__label">Active alerts</span><ShieldAlert size={18} /><strong>{summary.activeAlerts}</strong><small>{summary.criticalAlerts} critical</small>
        </button>
        <div className="priority-item priority-item--unknown">
          <span className="priority-item__label">Needs verification</span><Database size={18} /><strong>{summary.unknown + summary.neverSeen}</strong>
          <small><button type="button" className={activeFilter === 'UNKNOWN' ? 'is-active' : ''} onClick={() => onFilter('UNKNOWN')}>{summary.unknown} unknown</button><button type="button" className={activeFilter === 'NEVER_SEEN' ? 'is-active' : ''} onClick={() => onFilter('NEVER_SEEN')}>{summary.neverSeen} never seen</button></small>
        </div>
      </div>
    </section>
  );
}
