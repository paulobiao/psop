import { Activity, Building2, CheckCircle2, Clock3, Network, RefreshCw, Server } from 'lucide-react';

interface SituationBarProps {
  healthLabel: string;
  healthTone: 'connecting' | 'critical' | 'warning' | 'healthy';
  generatedAt: string;
  sites: number;
  monitored: number;
  managed: number;
  siteName: string;
  siteCode: string;
  evaluating: boolean;
  refreshing: boolean;
  canEvaluate: boolean;
  formatDate: (value: string | null) => string;
  onEvaluate: () => void;
  onRefresh: () => void;
}

export default function SituationBar(props: SituationBarProps) {
  return (
    <section className="situation-bar" aria-label="Current operational situation">
      <div className="situation-bar__identity">
        <span className="eyebrow">Security operations</span>
        <h1>Security operations</h1>
        <span className="situation-site"><Building2 size={13} />{props.siteName}<i />{props.siteCode}</span>
      </div>

      <div className={`situation-state situation-state--${props.healthTone}`}>
        <span className="situation-state__dot" />
        <span>
          <small>Fleet condition</small>
          <strong>{props.healthLabel}</strong>
        </span>
      </div>

      <div className="situation-metrics" aria-label="Fleet context">
        <span><Building2 size={15} /><small>Sites</small><strong>{props.sites}</strong></span>
        <span><Server size={15} /><small>Monitored</small><strong>{props.monitored}</strong></span>
        <span><Network size={15} /><small>Managed</small><strong>{props.managed}</strong></span>
      </div>

      <div className="situation-bar__actions">
        <span className="situation-updated"><Clock3 size={15} />{props.formatDate(props.generatedAt)}</span>
        {props.canEvaluate && (
          <button type="button" onClick={props.onEvaluate} disabled={props.evaluating}>
            <Activity className={props.evaluating ? 'spin' : undefined} size={17} />
            <span>Evaluate</span>
          </button>
        )}
        <button type="button" onClick={props.onRefresh} disabled={props.refreshing} aria-label="Refresh operations">
          <RefreshCw className={props.refreshing ? 'spin' : undefined} size={17} />
          <span>Refresh</span>
        </button>
      </div>
    </section>
  );
}
