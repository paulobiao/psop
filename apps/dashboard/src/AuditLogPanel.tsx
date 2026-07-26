import {
  Activity,
  Clock3,
  History,
  LoaderCircle,
  Search,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  getAuditLogs,
  type AuditLog,
} from './api';

interface AuditLogPanelProps {
  onClose: () => void;
}

function formatAction(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map(
      (part) =>
        part.charAt(0).toUpperCase() +
        part.slice(1),
    )
    .join(' ');
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
}

export default function AuditLogPanel({
  onClose,
}: AuditLogPanelProps) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [selectedId, setSelectedId] =
    useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] =
    useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void getAuditLogs(200, controller.signal)
      .then((result) => {
        setLogs(result);
        setSelectedId(result.at(0)?.id ?? null);
        setError(null);
      })
      .catch((requestError) => {
        if (controller.signal.aborted) {
          return;
        }

        setError(
          requestError instanceof Error
            ? requestError.message
            : 'Unable to load audit history',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const handleKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener(
      'keydown',
      handleKeyDown,
    );

    return () =>
      window.removeEventListener(
        'keydown',
        handleKeyDown,
      );
  }, [onClose]);

  const filteredLogs = useMemo(() => {
    const query = search.trim().toLowerCase();

    if (!query) {
      return logs;
    }

    return logs.filter((log) =>
      [
        log.actorName,
        log.actorEmail,
        log.actorRole,
        log.action,
        log.entityType,
        log.entityId ?? '',
        log.path,
      ].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [logs, search]);

  const selected =
    logs.find((log) => log.id === selectedId) ??
    filteredLogs.at(0) ??
    null;

  return (
    <div
      className="user-management-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="audit-log-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Audit history"
      >
        <header className="audit-log-header">
          <div className="audit-log-title">
            <span>
              <History size={22} />
            </span>

            <div>
              <span className="eyebrow">
                Organization security
              </span>
              <h2>Audit history</h2>
              <p>
                Immutable history of administrative and
                operational changes.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close audit history"
          >
            <X size={20} />
          </button>
        </header>

        <div className="audit-log-toolbar">
          <div className="audit-search">
            <Search size={17} />

            <input
              value={search}
              placeholder="Search actions, users or resources"
              onChange={(event) =>
                setSearch(event.target.value)
              }
            />
          </div>

          <span>
            {filteredLogs.length} recorded action
            {filteredLogs.length === 1 ? '' : 's'}
          </span>
        </div>

        {error && (
          <div className="inventory-message inventory-message--error">
            {error}
          </div>
        )}

        <div className="audit-log-layout">
          <div className="audit-log-list">
            {loading ? (
              <div className="audit-log-loading">
                <LoaderCircle
                  className="spin"
                  size={23}
                />
                Loading audit history…
              </div>
            ) : filteredLogs.length === 0 ? (
              <div className="details-empty">
                <History size={27} />
                <strong>No audit records</strong>
                <span>
                  Recorded changes will appear here.
                </span>
              </div>
            ) : (
              filteredLogs.map((log) => (
                <button
                  type="button"
                  key={log.id}
                  className={
                    selected?.id === log.id
                      ? 'audit-log-card audit-log-card--active'
                      : 'audit-log-card'
                  }
                  onClick={() =>
                    setSelectedId(log.id)
                  }
                >
                  <span className="audit-log-icon">
                    <Activity size={17} />
                  </span>

                  <span>
                    <strong>
                      {formatAction(log.action)}
                    </strong>

                    <small>
                      {log.actorName}
                      {' · '}
                      {formatDate(log.createdAt)}
                    </small>

                    <em>
                      {log.entityType}
                      {log.entityId
                        ? ` · ${log.entityId}`
                        : ''}
                    </em>
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="audit-log-details">
            {selected ? (
              <>
                <div className="audit-details-heading">
                  <span className="eyebrow">
                    Recorded action
                  </span>
                  <h3>
                    {formatAction(selected.action)}
                  </h3>
                  <p>{selected.path}</p>
                </div>

                <div className="audit-details-grid">
                  <article>
                    <UserRound size={17} />
                    <span>Performed by</span>
                    <strong>
                      {selected.actorName}
                    </strong>
                    <small>
                      {selected.actorEmail}
                      {' · '}
                      {selected.actorRole}
                    </small>
                  </article>

                  <article>
                    <ShieldCheck size={17} />
                    <span>Resource</span>
                    <strong>
                      {selected.entityType}
                    </strong>
                    <small>
                      {selected.entityId ??
                        'No resource identifier'}
                    </small>
                  </article>

                  <article>
                    <Activity size={17} />
                    <span>Request</span>
                    <strong>
                      {selected.method}
                      {' · HTTP '}
                      {selected.statusCode}
                    </strong>
                    <small>
                      {selected.ipAddress ??
                        'IP unavailable'}
                    </small>
                  </article>

                  <article>
                    <Clock3 size={17} />
                    <span>Recorded at</span>
                    <strong>
                      {formatDate(selected.createdAt)}
                    </strong>
                    <small>
                      {selected.metadata?.durationMs ??
                        0}
                      {' ms'}
                    </small>
                  </article>
                </div>

                <section className="audit-metadata">
                  <span className="eyebrow">
                    Change metadata
                  </span>

                  <pre>
                    {JSON.stringify(
                      selected.metadata,
                      null,
                      2,
                    )}
                  </pre>
                </section>
              </>
            ) : (
              <div className="details-empty">
                <History size={27} />
                <strong>No action selected</strong>
                <span>
                  Select an audit entry to inspect it.
                </span>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
