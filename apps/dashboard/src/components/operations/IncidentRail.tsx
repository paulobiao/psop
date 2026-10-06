import { Activity, ArrowRight, CheckCircle2, Clock3, ShieldAlert } from 'lucide-react';
import type { ActiveAlert, ConnectivityEvent } from '../../types';

const formatDate = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

export default function IncidentRail({ alerts, events, onOpenAlerts }: { alerts: ActiveAlert[]; events: ConnectivityEvent[]; onOpenAlerts: () => void }) {
  return <aside className="incident-rail" aria-label="Incident rail">
    <header><div><span className="eyebrow">Incident rail</span><h2>Active alerts</h2></div><button type="button" onClick={onOpenAlerts}>{alerts.length}<span className="sr-only"> open alert management</span></button></header>
    <div className="incident-rail__list">{alerts.length === 0 ? <div className="rail-empty"><CheckCircle2 size={22} /><strong>No active alerts</strong><span>The monitored fleet is clear.</span></div> : alerts.map((alert) => <article key={alert.id} className={`rail-alert rail-alert--${alert.severity.toLowerCase()}`}>
      <ShieldAlert size={17} /><div><div><strong>{alert.title}</strong><span className={`severity severity--${alert.severity.toLowerCase()}`}>{alert.severity}</span></div><p>{alert.deviceName} · {alert.siteName}</p><small><Clock3 size={12} />{formatDate(alert.openedAt)}</small></div>
    </article>)}</div>
    <button className="rail-view-all" type="button" onClick={onOpenAlerts}>View all alerts<ArrowRight size={15} /></button>
    <section className="rail-activity"><header><div><span className="eyebrow">Activity stream</span><h3>Recent changes</h3></div><Activity size={17} /></header><div>{events.slice(0, 6).map((event) => <article key={`${event.camera_id}-${event.timestamp}`}><span className={`rail-event-dot rail-event-dot--${event.current_state.toLowerCase()}`} /><div><strong>{event.device_name}</strong><span>{event.previous_state ? `${event.previous_state.replace('_', ' ')} → ${event.current_state.replace('_', ' ')}` : event.current_state.replace('_', ' ')}</span><small>{formatDate(event.detected_at)}</small></div></article>)}</div><span className="rail-view-all rail-view-all--static">View full activity<ArrowRight size={15} /></span></section>
  </aside>;
}
