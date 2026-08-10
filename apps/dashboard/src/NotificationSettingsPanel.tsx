import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  Mail,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  getNotificationDeliveries,
  getNotificationPolicy,
  getNotificationTransportStatus,
  processNotificationDeliveries,
  retryNotificationDelivery,
  updateNotificationPolicy,
} from "./api";
import type {
  NotificationDelivery,
  NotificationPolicy,
  NotificationTransportStatus,
} from "./types";

interface NotificationSettingsPanelProps {
  onClose: () => void;
}

function formatDate(
  value: string | null,
): string {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    },
  ).format(new Date(value));
}

function statusLabel(
  status: NotificationDelivery["status"],
): string {
  const labels: Record<
    NotificationDelivery["status"],
    string
  > = {
    PENDING: "Pending",
    SENT: "Sent",
    FAILED: "Failed",
    SKIPPED_NOT_CONFIGURED:
      "Email not configured",
    SKIPPED_COOLDOWN:
      "Cooldown",
    SKIPPED_POLICY:
      "Policy changed",
  };

  return labels[status];
}

function splitEmails(
  value: string,
): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,;]+/)
        .map((email) =>
          email.trim().toLowerCase(),
        )
        .filter(Boolean),
    ),
  );
}

export default function NotificationSettingsPanel({
  onClose,
}: NotificationSettingsPanelProps) {
  const [policy, setPolicy] =
    useState<NotificationPolicy | null>(
      null,
    );
  const [transport, setTransport] =
    useState<NotificationTransportStatus | null>(
      null,
    );
  const [deliveries, setDeliveries] =
    useState<NotificationDelivery[]>([]);
  const [explicitEmails, setExplicitEmails] =
    useState("");
  const [loading, setLoading] =
    useState(true);
  const [saving, setSaving] =
    useState(false);
  const [processing, setProcessing] =
    useState(false);
  const [retryingId, setRetryingId] =
    useState<string | null>(null);
  const [error, setError] =
    useState<string | null>(null);
  const [notice, setNotice] =
    useState<string | null>(null);

  const load = useCallback(
    async () => {
      setLoading(true);

      try {
        const [
          nextPolicy,
          nextTransport,
          nextDeliveries,
        ] = await Promise.all([
          getNotificationPolicy(),
          getNotificationTransportStatus(),
          getNotificationDeliveries(100),
        ]);

        setPolicy(nextPolicy);
        setTransport(nextTransport);
        setDeliveries(nextDeliveries);
        setExplicitEmails(
          nextPolicy.explicitEmails.join(
            "\n",
          ),
        );
        setError(null);
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to load notification settings",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener(
      "keydown",
      onKeyDown,
    );

    return () =>
      window.removeEventListener(
        "keydown",
        onKeyDown,
      );
  }, [onClose]);

  const summary = useMemo(
    () => ({
      sent: deliveries.filter(
        (delivery) =>
          delivery.status === "SENT",
      ).length,
      pending: deliveries.filter(
        (delivery) =>
          delivery.status === "PENDING",
      ).length,
      failed: deliveries.filter(
        (delivery) =>
          delivery.status === "FAILED",
      ).length,
      skipped: deliveries.filter(
        (delivery) =>
          delivery.status.startsWith(
            "SKIPPED_",
          ),
      ).length,
    }),
    [deliveries],
  );

  async function savePolicy() {
    if (!policy) {
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      const updated =
        await updateNotificationPolicy({
          enabled: policy.enabled,
          minimumSeverity:
            policy.minimumSeverity,
          notifyOnRecovery:
            policy.notifyOnRecovery,
          notifyAdmins:
            policy.notifyAdmins,
          notifyOperators:
            policy.notifyOperators,
          explicitEmails:
            splitEmails(explicitEmails),
          cooldownMinutes:
            policy.cooldownMinutes,
          escalationDelayMinutes:
            policy.escalationDelayMinutes,
        });

      setPolicy(updated);
      setExplicitEmails(
        updated.explicitEmails.join(
          "\n",
        ),
      );
      setNotice(
        "Notification policy saved.",
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to save notification policy",
      );
    } finally {
      setSaving(false);
    }
  }

  async function processDue() {
    setProcessing(true);
    setError(null);
    setNotice(null);

    try {
      const result =
        await processNotificationDeliveries();

      setNotice(
        `${result.processed} due delivery${
          result.processed === 1
            ? ""
            : "ies"
        } processed.`,
      );

      await load();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to process notification deliveries",
      );
    } finally {
      setProcessing(false);
    }
  }

  async function retry(
    deliveryId: string,
  ) {
    setRetryingId(deliveryId);
    setError(null);
    setNotice(null);

    try {
      await retryNotificationDelivery(
        deliveryId,
      );
      setNotice(
        "Delivery retry processed.",
      );
      await load();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to retry notification",
      );
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div
      className="notification-settings-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (
          event.target ===
          event.currentTarget
        ) {
          onClose();
        }
      }}
    >
      <section
        className="notification-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Incident notifications"
      >
        <header className="notification-settings-header">
          <div className="notification-settings-title">
            <span className="notification-settings-title__icon">
              <BellRing size={22} />
            </span>
            <div>
              <span className="eyebrow">
                Incident response
              </span>
              <h2>
                Notifications & escalation
              </h2>
              <p>
                Configure who receives
                connectivity incident and
                recovery email notifications.
              </p>
            </div>
          </div>

          <div className="notification-settings-actions">
            <button
              type="button"
              className="icon-button"
              onClick={() => void load()}
              disabled={loading}
              aria-label="Refresh notification settings"
            >
              <RefreshCw
                size={18}
                className={
                  loading
                    ? "spin"
                    : undefined
                }
              />
            </button>

            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label="Close notification settings"
            >
              <X size={20} />
            </button>
          </div>
        </header>

        {loading && !policy ? (
          <div className="details-loading">
            <LoaderCircle
              className="spin"
              size={26}
            />
            <strong>
              Loading notification configuration…
            </strong>
          </div>
        ) : policy && transport ? (
          <>
            <section className="notification-transport-card">
              <div>
                <span
                  className={
                    transport.configured
                      ? "notification-transport-icon notification-transport-icon--ready"
                      : "notification-transport-icon notification-transport-icon--missing"
                  }
                >
                  {transport.configured ? (
                    <ShieldCheck size={20} />
                  ) : (
                    <AlertTriangle size={20} />
                  )}
                </span>

                <div>
                  <span className="eyebrow">
                    Email transport
                  </span>
                  <h3>
                    {transport.configured
                      ? "SMTP configured"
                      : "SMTP not configured"}
                  </h3>
                  <p>
                    {transport.configured
                      ? `Ready on port ${transport.port}. Authentication: ${transport.authentication.toLowerCase()}.`
                      : "PSOP will preserve NOT CONFIGURED delivery evidence instead of pretending an email was sent."}
                  </p>
                </div>
              </div>

              <small>
                SMTP credentials are server
                environment settings and are
                never exposed here.
              </small>
            </section>

            <section className="notification-policy-grid">
              <article className="notification-policy-card">
                <div className="notification-card-heading">
                  <div>
                    <span className="eyebrow">
                      Policy
                    </span>
                    <h3>
                      Incident delivery
                    </h3>
                  </div>

                  <label className="notification-switch">
                    <input
                      type="checkbox"
                      checked={policy.enabled}
                      onChange={(event) =>
                        setPolicy({
                          ...policy,
                          enabled:
                            event.target.checked,
                        })
                      }
                    />
                    <span>
                      {policy.enabled
                        ? "Enabled"
                        : "Disabled"}
                    </span>
                  </label>
                </div>

                <div className="notification-form-grid">
                  <label>
                    <span>
                      Minimum severity
                    </span>
                    <select
                      value={
                        policy.minimumSeverity
                      }
                      onChange={(event) =>
                        setPolicy({
                          ...policy,
                          minimumSeverity:
                            event.target.value as
                              | "WARNING"
                              | "CRITICAL",
                        })
                      }
                    >
                      <option value="CRITICAL">
                        Critical only
                      </option>
                      <option value="WARNING">
                        Warning + Critical
                      </option>
                    </select>
                  </label>

                  <label>
                    <span>
                      Cooldown
                    </span>
                    <div className="notification-number-field">
                      <input
                        type="number"
                        min={0}
                        max={1440}
                        value={
                          policy.cooldownMinutes
                        }
                        onChange={(event) =>
                          setPolicy({
                            ...policy,
                            cooldownMinutes:
                              Math.max(
                                0,
                                Number(
                                  event.target.value,
                                ) || 0,
                              ),
                          })
                        }
                      />
                      <small>
                        minutes
                      </small>
                    </div>
                  </label>

                  <label>
                    <span>
                      Escalation delay
                    </span>
                    <div className="notification-number-field">
                      <input
                        type="number"
                        min={0}
                        max={1440}
                        value={
                          policy.escalationDelayMinutes
                        }
                        onChange={(event) =>
                          setPolicy({
                            ...policy,
                            escalationDelayMinutes:
                              Math.max(
                                0,
                                Number(
                                  event.target.value,
                                ) || 0,
                              ),
                          })
                        }
                      />
                      <small>
                        minutes
                      </small>
                    </div>
                  </label>
                </div>

                <div className="notification-checks">
                  <label>
                    <input
                      type="checkbox"
                      checked={
                        policy.notifyOnRecovery
                      }
                      onChange={(event) =>
                        setPolicy({
                          ...policy,
                          notifyOnRecovery:
                            event.target.checked,
                        })
                      }
                    />
                    Send recovery notifications
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={
                        policy.notifyAdmins
                      }
                      onChange={(event) =>
                        setPolicy({
                          ...policy,
                          notifyAdmins:
                            event.target.checked,
                        })
                      }
                    />
                    Active ADMIN users
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={
                        policy.notifyOperators
                      }
                      onChange={(event) =>
                        setPolicy({
                          ...policy,
                          notifyOperators:
                            event.target.checked,
                        })
                      }
                    />
                    Active OPERATOR users
                  </label>
                </div>
              </article>

              <article className="notification-policy-card">
                <span className="eyebrow">
                  Additional recipients
                </span>
                <h3>
                  Explicit email addresses
                </h3>
                <p>
                  Add up to 20 addresses,
                  separated by commas,
                  semicolons or new lines.
                </p>

                <textarea
                  className="notification-email-input"
                  value={explicitEmails}
                  onChange={(event) =>
                    setExplicitEmails(
                      event.target.value,
                    )
                  }
                  rows={7}
                  placeholder={"security@example.com\nmanager@example.com"}
                />

                <p className="notification-helper">
                  Role recipients are resolved
                  only from active users in
                  this organization.
                </p>
              </article>
            </section>

            <div className="notification-save-row">
              {error && (
                <div className="panel-error">
                  {error}
                </div>
              )}

              {notice && (
                <div className="notification-notice">
                  <CheckCircle2 size={16} />
                  {notice}
                </div>
              )}

              <button
                type="button"
                className="notification-primary-button"
                onClick={() =>
                  void savePolicy()
                }
                disabled={saving}
              >
                {saving ? (
                  <LoaderCircle
                    className="spin"
                    size={16}
                  />
                ) : (
                  <Save size={16} />
                )}
                Save policy
              </button>
            </div>

            <section className="notification-history">
              <div className="notification-history-heading">
                <div>
                  <span className="eyebrow">
                    Delivery evidence
                  </span>
                  <h3>
                    Notification history
                  </h3>
                  <p>
                    Idempotent delivery records
                    for incident opening and
                    recovery transitions.
                  </p>
                </div>

                <button
                  type="button"
                  className="notification-secondary-button"
                  onClick={() =>
                    void processDue()
                  }
                  disabled={processing}
                >
                  {processing ? (
                    <LoaderCircle
                      className="spin"
                      size={15}
                    />
                  ) : (
                    <Clock3 size={15} />
                  )}
                  Process due
                </button>
              </div>

              <div className="notification-history-summary">
                <article>
                  <span>Sent</span>
                  <strong>
                    {summary.sent}
                  </strong>
                </article>
                <article>
                  <span>Pending</span>
                  <strong>
                    {summary.pending}
                  </strong>
                </article>
                <article>
                  <span>Failed</span>
                  <strong>
                    {summary.failed}
                  </strong>
                </article>
                <article>
                  <span>Skipped</span>
                  <strong>
                    {summary.skipped}
                  </strong>
                </article>
              </div>

              <div className="notification-delivery-list">
                {deliveries.map(
                  (delivery) => (
                    <article
                      className="notification-delivery"
                      key={delivery.id}
                    >
                      <span
                        className={`notification-delivery__icon notification-delivery__icon--${delivery.status.toLowerCase()}`}
                      >
                        <Mail size={17} />
                      </span>

                      <div className="notification-delivery__body">
                        <div>
                          <strong>
                            {delivery.eventType ===
                            "INCIDENT_RECOVERED"
                              ? "Recovery"
                              : "Incident"}{" "}
                            ·{" "}
                            {delivery.device.name}
                          </strong>
                          <span
                            className={`notification-status notification-status--${delivery.status.toLowerCase()}`}
                          >
                            {statusLabel(
                              delivery.status,
                            )}
                          </span>
                        </div>

                        <p>
                          {delivery.subject}
                        </p>

                        <small>
                          {delivery.recipientEmail}
                          {" · "}
                          {delivery.recipientSource}
                          {" · "}
                          {delivery.device.siteName}
                        </small>

                        <small>
                          Created{" "}
                          {formatDate(
                            delivery.createdAt,
                          )}
                          {delivery.sentAt
                            ? ` · Sent ${formatDate(delivery.sentAt)}`
                            : ""}
                        </small>

                        {delivery.lastError && (
                          <div className="notification-delivery__error">
                            {delivery.lastError}
                          </div>
                        )}
                      </div>

                      {(
                        delivery.status ===
                          "FAILED" ||
                        delivery.status ===
                          "SKIPPED_NOT_CONFIGURED"
                      ) && (
                        <button
                          type="button"
                          className="notification-retry"
                          onClick={() =>
                            void retry(
                              delivery.id,
                            )
                          }
                          disabled={
                            retryingId ===
                            delivery.id
                          }
                        >
                          {retryingId ===
                          delivery.id ? (
                            <LoaderCircle
                              className="spin"
                              size={14}
                            />
                          ) : (
                            <RotateCcw
                              size={14}
                            />
                          )}
                          Retry
                        </button>
                      )}
                    </article>
                  ),
                )}

                {deliveries.length ===
                  0 && (
                  <div className="details-empty">
                    <Server size={26} />
                    <strong>
                      No notification evidence yet
                    </strong>
                    <span>
                      Matching incident transitions
                      will appear here after the
                      policy is enabled.
                    </span>
                  </div>
                )}
              </div>
            </section>
          </>
        ) : null}
      </section>
    </div>
  );
}
