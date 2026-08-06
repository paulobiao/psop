import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  History,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  OperationalIncident,
} from "./types";

type IncidentFilter =
  | "ALL"
  | "OPEN"
  | "RESOLVED";

interface IncidentHistoryPanelProps {
  incidents: OperationalIncident[];
  generatedAt: string;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

function formatDate(value: string | null): string {
  if (!value) {
    return "Ongoing";
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
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  }

  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(
      (seconds % 3600) / 60,
    );
    return `${hours}h ${minutes}m`;
  }

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(
    (seconds % 86400) / 3600,
  );
  return `${days}d ${hours}h`;
}

export default function IncidentHistoryPanel({
  incidents,
  generatedAt,
  refreshing,
  onRefresh,
  onClose,
}: IncidentHistoryPanelProps) {
  const [filter, setFilter] =
    useState<IncidentFilter>("ALL");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const handleKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener(
      "keydown",
      handleKeyDown,
    );

    return () =>
      window.removeEventListener(
        "keydown",
        handleKeyDown,
      );
  }, [onClose]);

  const filtered = useMemo(() => {
    const normalized =
      search.trim().toLowerCase();

    return incidents.filter((incident) => {
      const matchesFilter =
        filter === "ALL" ||
        incident.status === filter;

      const matchesSearch =
        !normalized ||
        [
          incident.deviceName,
          incident.externalId,
          incident.siteName,
          incident.siteCode,
          incident.title,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalized);

      return matchesFilter && matchesSearch;
    });
  }, [filter, incidents, search]);

  const openCount = incidents.filter(
    (incident) => incident.status === "OPEN",
  ).length;

  const resolvedCount =
    incidents.length - openCount;

  const totalDuration = incidents.reduce(
    (total, incident) =>
      total + incident.durationSeconds,
    0,
  );

  return (
    <div
      className="incident-history-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="incident-history-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Operational incident history"
      >
        <header className="incident-history-header">
          <div className="incident-history-title">
            <span className="incident-history-title__icon">
              <History size={22} />
            </span>

            <div>
              <span className="eyebrow">
                Operational evidence
              </span>
              <h2>Incident history</h2>
              <p>
                Connectivity interruptions, recoveries and
                measured duration for directly monitored
                equipment.
              </p>
            </div>
          </div>

          <div className="incident-history-actions">
            <button
              type="button"
              className="icon-button"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Refresh incident history"
            >
              <RefreshCw
                size={18}
                className={
                  refreshing ? "spin" : undefined
                }
              />
            </button>

            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label="Close incident history"
            >
              <X size={20} />
            </button>
          </div>
        </header>

        <section className="incident-history-summary">
          <article>
            <span>Total incidents</span>
            <strong>{incidents.length}</strong>
          </article>
          <article className="incident-summary-open">
            <span>Ongoing</span>
            <strong>{openCount}</strong>
          </article>
          <article className="incident-summary-resolved">
            <span>Recovered</span>
            <strong>{resolvedCount}</strong>
          </article>
          <article>
            <span>Recorded duration</span>
            <strong>
              {formatDuration(totalDuration)}
            </strong>
          </article>
        </section>

        <div className="incident-history-toolbar">
          <div className="incident-filter-group">
            {(
              [
                "ALL",
                "OPEN",
                "RESOLVED",
              ] as IncidentFilter[]
            ).map((value) => (
              <button
                key={value}
                type="button"
                className={
                  filter === value
                    ? "incident-filter incident-filter--active"
                    : "incident-filter"
                }
                onClick={() => setFilter(value)}
              >
                {value === "ALL"
                  ? "All"
                  : value === "OPEN"
                    ? "Ongoing"
                    : "Recovered"}
              </button>
            ))}
          </div>

          <label className="incident-search">
            <Search size={17} />
            <input
              value={search}
              onChange={(event) =>
                setSearch(event.target.value)
              }
              placeholder="Search device, site or incident"
            />
          </label>
        </div>

        <div className="incident-history-generated">
          Updated {formatDate(generatedAt)} · Showing{" "}
          {filtered.length} of {incidents.length}
        </div>

        <div className="incident-history-list">
          {filtered.map((incident) => (
            <article
              className="operational-incident"
              key={incident.id}
            >
              <span
                className={`operational-incident__icon operational-incident__icon--${incident.severity.toLowerCase()}`}
              >
                {incident.status === "RESOLVED" ? (
                  <CheckCircle2 size={20} />
                ) : (
                  <AlertTriangle size={20} />
                )}
              </span>

              <div className="operational-incident__content">
                <div className="operational-incident__heading">
                  <div>
                    <strong>{incident.title}</strong>
                    <small>
                      {incident.deviceName} ·{" "}
                      {incident.externalId}
                    </small>
                  </div>

                  <span
                    className={
                      incident.status === "OPEN"
                        ? "incident-status incident-status--open"
                        : "incident-status incident-status--resolved"
                    }
                  >
                    {incident.status === "OPEN"
                      ? "ONGOING"
                      : "RECOVERED"}
                  </span>
                </div>

                <p>{incident.message}</p>

                <div className="operational-incident__meta">
                  <span>
                    {incident.siteName} (
                    {incident.siteCode})
                  </span>
                  <span>
                    Direct telemetry
                  </span>
                </div>

                <div className="operational-incident__time">
                  <span>
                    <Clock3 size={14} />
                    Started{" "}
                    {formatDate(incident.startedAt)}
                  </span>
                  <span>
                    Ended{" "}
                    {formatDate(incident.endedAt)}
                  </span>
                  <strong>
                    Duration{" "}
                    {formatDuration(
                      incident.durationSeconds,
                    )}
                  </strong>
                </div>
              </div>
            </article>
          ))}

          {filtered.length === 0 && (
            <div className="details-empty">
              <History size={28} />
              <strong>No incidents found</strong>
              <span>
                Connectivity incidents will appear after a
                directly monitored device changes state.
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
