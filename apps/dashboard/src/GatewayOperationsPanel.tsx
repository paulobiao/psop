import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  Network,
  RefreshCw,
  TimerReset,
  X,
} from "lucide-react";
import { useEffect } from "react";
import type {
  EdgeAgentRuntime,
} from "./types";

interface GatewayOperationsPanelProps {
  agents: EdgeAgentRuntime[];
  generatedAt: string;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

function formatDate(value: string | null): string {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}d ${hours}h`;
}

export default function GatewayOperationsPanel({
  agents,
  generatedAt,
  refreshing,
  onRefresh,
  onClose,
}: GatewayOperationsPanelProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const reporting = agents.filter(
    (agent) => agent.report.freshness === "REPORTING",
  ).length;

  const pending = agents.reduce(
    (total, agent) => total + agent.runtime.pendingBufferCount,
    0,
  );

  return (
    <div
      className="gateway-operations-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="gateway-operations-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edge agent operations"
      >
        <header className="gateway-operations-header">
          <div className="gateway-operations-title">
            <span className="gateway-operations-title__icon">
              <Network size={22} />
            </span>
            <div>
              <span className="eyebrow">Edge observability</span>
              <h2>Gateway operations</h2>
              <p>
                Last reported runtime, API delivery and local buffer state
                from manually started PSOP edge agents.
              </p>
            </div>
          </div>

          <div className="gateway-operations-actions">
            <button
              type="button"
              className="icon-button"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Refresh gateway operations"
            >
              <RefreshCw
                size={18}
                className={refreshing ? "spin" : undefined}
              />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label="Close gateway operations"
            >
              <X size={20} />
            </button>
          </div>
        </header>

        <section className="gateway-operations-summary">
          <article>
            <span>Known agents</span>
            <strong>{agents.length}</strong>
          </article>
          <article className="gateway-summary-good">
            <span>Reporting now</span>
            <strong>{reporting}</strong>
          </article>
          <article>
            <span>Stale reports</span>
            <strong>{agents.length - reporting}</strong>
          </article>
          <article className={pending > 0 ? "gateway-summary-warning" : undefined}>
            <span>Pending at last report</span>
            <strong>{pending}</strong>
          </article>
        </section>

        <div className="gateway-operations-generated">
          Updated {formatDate(generatedAt)} · Gateway execution remains manual.
        </div>

        <div className="gateway-operations-list">
          {agents.map((agent) => (
            <article className="edge-agent-card" key={agent.device.id}>
              <div className="edge-agent-card__heading">
                <div>
                  <span className="eyebrow">{agent.device.siteName}</span>
                  <h3>{agent.device.name}</h3>
                  <small>
                    {agent.device.externalId} · Agent {agent.runtime.agentVersion}
                  </small>
                </div>

                <span
                  className={
                    agent.report.freshness === "REPORTING"
                      ? "agent-report agent-report--reporting"
                      : "agent-report agent-report--stale"
                  }
                >
                  {agent.report.freshness}
                </span>
              </div>

              <div className="edge-agent-metrics">
                <article>
                  <span><CheckCircle2 size={15} />Delivery</span>
                  <strong>{agent.runtime.deliveryState}</strong>
                  <small>
                    Previous {agent.runtime.previousDeliveryState ?? "not reported"}
                  </small>
                </article>

                <article>
                  <span><Database size={15} />Buffer</span>
                  <strong>{agent.runtime.pendingBufferCount} pending</strong>
                  <small>At last successful report</small>
                </article>

                <article>
                  <span><TimerReset size={15} />Runtime</span>
                  <strong>{formatDuration(agent.runtime.uptimeSeconds)}</strong>
                  <small>Started {formatDate(agent.runtime.runtimeStartedAt)}</small>
                </article>

                <article>
                  <span><Clock3 size={15} />Last API delivery</span>
                  <strong>{formatDate(agent.runtime.lastSuccessfulDeliveryAt)}</strong>
                  <small>Report age {formatDuration(agent.report.ageSeconds)}</small>
                </article>
              </div>

              {agent.runtime.lastDeliveryError && (
                <div className="edge-agent-error">
                  <AlertTriangle size={17} />
                  <div>
                    <strong>Last delivery error</strong>
                    <span>{agent.runtime.lastDeliveryError}</span>
                    <small>{formatDate(agent.runtime.lastDeliveryErrorAt)}</small>
                  </div>
                </div>
              )}

              <footer className="edge-agent-card__footer">
                <span>Site {agent.device.siteCode}</span>
                <span>Last runtime report {formatDate(agent.report.receivedAt)}</span>
              </footer>
            </article>
          ))}

          {agents.length === 0 && (
            <div className="details-empty">
              <Network size={28} />
              <strong>No edge-agent runtime reported yet</strong>
              <span>
                Start the gateway manually during a test. Runtime telemetry
                will appear after its first successful API delivery.
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
