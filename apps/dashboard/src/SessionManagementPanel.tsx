import {
  Clock3,
  KeyRound,
  Laptop,
  LoaderCircle,
  LogOut,
  Search,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  getAuthSessions,
  revokeAuthSession,
  revokeUserAuthSessions,
  type AuthSession,
} from './api';

interface SessionManagementPanelProps {
  onClose: () => void;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function sessionDevice(
  userAgent: string | null,
): string {
  if (!userAgent) {
    return 'Unknown device';
  }

  if (
    /iphone|ipad|android|mobile/i.test(
      userAgent,
    )
  ) {
    return 'Mobile device';
  }

  if (/macintosh|mac os/i.test(userAgent)) {
    return 'Mac computer';
  }

  if (/windows/i.test(userAgent)) {
    return 'Windows computer';
  }

  if (/linux/i.test(userAgent)) {
    return 'Linux computer';
  }

  return 'Web browser';
}

export default function SessionManagementPanel({
  onClose,
}: SessionManagementPanelProps) {
  const [sessions, setSessions] =
    useState<AuthSession[]>([]);
  const [selectedId, setSelectedId] =
    useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] =
    useState<string | null>(null);
  const [error, setError] =
    useState<string | null>(null);
  const [success, setSuccess] =
    useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);

    try {
      const result = await getAuthSessions();

      setSessions(result);
      setSelectedId((current) => {
        if (
          current &&
          result.some(
            (session) => session.id === current,
          )
        ) {
          return current;
        }

        return result.at(0)?.id ?? null;
      });
      setError(null);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to load sessions',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

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

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();

    if (!query) {
      return sessions;
    }

    return sessions.filter((session) =>
      [
        session.userName,
        session.userEmail,
        session.userRole,
        session.state,
        session.ipAddress ?? '',
        session.userAgent ?? '',
      ].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [sessions, search]);

  const selected =
    sessions.find(
      (session) => session.id === selectedId,
    ) ??
    filteredSessions.at(0) ??
    null;

  const activeCount = sessions.filter(
    (session) => session.state === 'ACTIVE',
  ).length;

  async function handleRevokeSession() {
    if (
      !selected ||
      selected.current ||
      selected.state !== 'ACTIVE'
    ) {
      return;
    }

    const confirmed = window.confirm(
      `Revoke the session for ${selected.userName}?`,
    );

    if (!confirmed) {
      return;
    }

    setSubmitting('session');
    setError(null);
    setSuccess(null);

    try {
      await revokeAuthSession(selected.id);
      await loadSessions();

      setSuccess(
        `Session revoked for ${selected.userName}.`,
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to revoke session',
      );
    } finally {
      setSubmitting(null);
    }
  }

  async function handleRevokeUser() {
    if (!selected || selected.current) {
      return;
    }

    const confirmed = window.confirm(
      `Sign ${selected.userName} out from every device?`,
    );

    if (!confirmed) {
      return;
    }

    setSubmitting('user');
    setError(null);
    setSuccess(null);

    try {
      const result =
        await revokeUserAuthSessions(
          selected.userId,
        );

      await loadSessions();

      setSuccess(
        `${result.revokedSessions} session(s) revoked for ${selected.userName}.`,
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to revoke user sessions',
      );
    } finally {
      setSubmitting(null);
    }
  }

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
        className="session-management-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Session management"
      >
        <header className="session-management-header">
          <div className="session-management-title">
            <span>
              <KeyRound size={22} />
            </span>

            <div>
              <span className="eyebrow">
                Access security
              </span>
              <h2>Active sessions</h2>
              <p>
                Review and revoke authenticated access
                across this organization.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close sessions"
          >
            <X size={20} />
          </button>
        </header>

        <div className="session-summary">
          <article>
            <span>Recorded sessions</span>
            <strong>{sessions.length}</strong>
          </article>

          <article>
            <span>Active access</span>
            <strong>{activeCount}</strong>
          </article>

          <article>
            <span>Revoked or expired</span>
            <strong>
              {sessions.length - activeCount}
            </strong>
          </article>
        </div>

        <div className="session-toolbar">
          <div className="audit-search">
            <Search size={17} />

            <input
              value={search}
              placeholder="Search users, devices or IP addresses"
              onChange={(event) =>
                setSearch(event.target.value)
              }
            />
          </div>
        </div>

        {(error || success) && (
          <div
            className={
              error
                ? 'inventory-message inventory-message--error'
                : 'inventory-message inventory-message--success'
            }
          >
            {error ?? success}
          </div>
        )}

        <div className="session-management-layout">
          <div className="session-list">
            {loading ? (
              <div className="audit-log-loading">
                <LoaderCircle
                  className="spin"
                  size={23}
                />
                Loading sessions…
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="details-empty">
                <KeyRound size={27} />
                <strong>No sessions found</strong>
                <span>
                  Authenticated sessions will appear here.
                </span>
              </div>
            ) : (
              filteredSessions.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  className={
                    selected?.id === session.id
                      ? 'session-card session-card--active'
                      : 'session-card'
                  }
                  onClick={() =>
                    setSelectedId(session.id)
                  }
                >
                  <span className="session-device-icon">
                    <Laptop size={18} />
                  </span>

                  <span>
                    <strong>
                      {session.userName}
                    </strong>

                    <small>
                      {sessionDevice(
                        session.userAgent,
                      )}
                      {' · '}
                      {session.ipAddress ??
                        'Unknown IP'}
                    </small>

                    <em>
                      {session.state}
                      {session.current
                        ? ' · CURRENT SESSION'
                        : ''}
                    </em>
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="session-details">
            {selected ? (
              <>
                <div className="session-details-heading">
                  <span className="eyebrow">
                    Authenticated access
                  </span>

                  <h3>{selected.userName}</h3>
                  <p>{selected.userEmail}</p>

                  <span
                    className={
                      `session-state session-state--${selected.state.toLowerCase()}`
                    }
                  >
                    {selected.state}
                    {selected.current
                      ? ' · CURRENT'
                      : ''}
                  </span>
                </div>

                <div className="session-details-grid">
                  <article>
                    <UserRound size={17} />
                    <span>User profile</span>
                    <strong>
                      {selected.userRole}
                    </strong>
                    <small>
                      Account {selected.userStatus}
                    </small>
                  </article>

                  <article>
                    <Laptop size={17} />
                    <span>Device</span>
                    <strong>
                      {sessionDevice(
                        selected.userAgent,
                      )}
                    </strong>
                    <small>
                      {selected.ipAddress ??
                        'IP unavailable'}
                    </small>
                  </article>

                  <article>
                    <Clock3 size={17} />
                    <span>Created</span>
                    <strong>
                      {formatDate(
                        selected.createdAt,
                      )}
                    </strong>
                    <small>
                      Last renewed{' '}
                      {formatDate(
                        selected.lastUsedAt,
                      )}
                    </small>
                  </article>

                  <article>
                    <ShieldCheck size={17} />
                    <span>Expiration</span>
                    <strong>
                      {formatDate(
                        selected.expiresAt,
                      )}
                    </strong>
                    <small>
                      {selected.revokedAt
                        ? `Revoked ${formatDate(
                            selected.revokedAt,
                          )}`
                        : 'Not revoked'}
                    </small>
                  </article>
                </div>

                <section className="session-user-agent">
                  <span className="eyebrow">
                    Browser identification
                  </span>
                  <p>
                    {selected.userAgent ??
                      'User agent unavailable'}
                  </p>
                </section>

                <div className="session-actions">
                  <button
                    type="button"
                    className="user-danger-button"
                    disabled={
                      selected.current ||
                      selected.state !== 'ACTIVE' ||
                      submitting !== null
                    }
                    onClick={() =>
                      void handleRevokeSession()
                    }
                  >
                    <LogOut size={16} />
                    Revoke this session
                  </button>

                  <button
                    type="button"
                    className="user-danger-button"
                    disabled={
                      selected.current ||
                      selected.state !== 'ACTIVE' ||
                      submitting !== null
                    }
                    onClick={() =>
                      void handleRevokeUser()
                    }
                  >
                    <KeyRound size={16} />
                    Sign out from all devices
                  </button>
                </div>

                {selected.current && (
                  <div className="user-current-account">
                    <ShieldCheck size={17} />
                    Use the sign-out button in the
                    dashboard to close your current
                    session.
                  </div>
                )}
              </>
            ) : (
              <div className="details-empty">
                <KeyRound size={27} />
                <strong>No session selected</strong>
                <span>
                  Select a session to inspect it.
                </span>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
