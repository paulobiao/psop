import {
  Check,
  Copy,
  EyeOff,
  KeyRound,
  LoaderCircle,
  RotateCw,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getDeviceIngestionKeyStatus, rotateDeviceIngestionKey } from "./api";
import { useAuthUser } from "./AuthGate";
import type {
  DeviceIngestionKeyStatus,
  RotatedDeviceIngestionKey,
} from "./types";

interface DeviceIngestionPanelProps {
  deviceId: string;
}

type CopiedValue = "key" | "command" | null;

function formatCredentialDate(value: string | null): string {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);

    return;
  }

  const textarea = document.createElement("textarea");

  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.setAttribute("readonly", "");

  document.body.appendChild(textarea);

  textarea.select();

  const copied = document.execCommand("copy");

  textarea.remove();

  if (!copied) {
    throw new Error("Clipboard access is unavailable");
  }
}

export default function DeviceIngestionPanel({
  deviceId,
}: DeviceIngestionPanelProps) {
  const user = useAuthUser();

  const [status, setStatus] = useState<DeviceIngestionKeyStatus | null>(null);

  const [secret, setSecret] = useState<RotatedDeviceIngestionKey | null>(null);

  const [loading, setLoading] = useState(true);

  const [rotating, setRotating] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const [copied, setCopied] = useState<CopiedValue>(null);

  const canManage = user.role === "ADMIN" || user.role === "OPERATOR";

  const simulatorCommand = useMemo(
    () =>
      `read -s "PSOP_DEVICE_KEY?Paste device key: "; echo; PSOP_DEVICE_KEY="$PSOP_DEVICE_KEY" python3 apps/simulator/local_http_simulator.py --device-id '${deviceId}' --state online --once; unset PSOP_DEVICE_KEY`,
    [deviceId],
  );

  useEffect(() => {
    const controller = new AbortController();

    setLoading(true);
    setError(null);
    setSecret(null);
    setCopied(null);

    void getDeviceIngestionKeyStatus(deviceId, controller.signal)
      .then((result) => {
        setStatus(result);
      })
      .catch((requestError) => {
        if (
          requestError instanceof DOMException &&
          requestError.name === "AbortError"
        ) {
          return;
        }

        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to load device credential",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [deviceId]);

  useEffect(() => {
    if (!secret) {
      return;
    }

    const timeout = window.setTimeout(
      () => {
        setSecret(null);
        setCopied(null);
      },
      5 * 60 * 1000,
    );

    return () => window.clearTimeout(timeout);
  }, [secret]);

  async function handleRotate() {
    if (
      status?.configured &&
      !window.confirm(
        "Rotate this camera key? The previous key will stop working immediately.",
      )
    ) {
      return;
    }

    setRotating(true);
    setError(null);
    setCopied(null);

    try {
      const result = await rotateDeviceIngestionKey(deviceId);

      setSecret(result);

      setStatus({
        enabled: result.enabled,
        configured: true,
        keyPrefix: result.keyPrefix,
        rotatedAt: result.rotatedAt,
      });
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to rotate the device key",
      );
    } finally {
      setRotating(false);
    }
  }

  async function handleCopy(kind: Exclude<CopiedValue, null>, value: string) {
    setError(null);

    try {
      await copyText(value);
      setCopied(kind);

      window.setTimeout(() => {
        setCopied((current) => (current === kind ? null : current));
      }, 1800);
    } catch (copyError) {
      setError(
        copyError instanceof Error
          ? copyError.message
          : "Unable to copy to clipboard",
      );
    }
  }

  return (
    <section className="details-section ingestion-management">
      <div className="details-section__heading">
        <div>
          <span className="eyebrow">Device authentication</span>
          <h3>Telemetry credential</h3>
        </div>

        <KeyRound size={19} />
      </div>

      <div className="ingestion-management__body">
        {loading && (
          <div className="ingestion-management__loading">
            <LoaderCircle className="spin" size={18} />
            Checking credential…
          </div>
        )}

        {!loading && status && (
          <>
            <div className="ingestion-management__status">
              <div>
                <span
                  className={`credential-state credential-state--${
                    status.configured ? "configured" : "missing"
                  }`}
                >
                  <ShieldCheck size={15} />
                  {status.configured ? "Configured" : "Not configured"}
                </span>

                <p>
                  {status.configured
                    ? "This camera can authenticate telemetry heartbeats."
                    : "Generate a key before connecting a local camera or simulator."}
                </p>
              </div>

              {canManage && status.enabled && (
                <button
                  type="button"
                  className="credential-primary"
                  onClick={() => void handleRotate()}
                  disabled={rotating}
                >
                  {rotating ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <RotateCw size={16} />
                  )}

                  {status.configured ? "Rotate key" : "Generate key"}
                </button>
              )}
            </div>

            <div className="credential-metadata">
              <div>
                <small>Key prefix</small>
                <strong>{status.keyPrefix ?? "Not available"}</strong>
              </div>

              <div>
                <small>Last rotation</small>
                <strong>{formatCredentialDate(status.rotatedAt)}</strong>
              </div>
            </div>

            {!status.enabled && (
              <div className="credential-notice">
                Local telemetry ingestion is disabled for this API session.
                Start the API with the Local Ingestion task to generate or
                rotate keys.
              </div>
            )}

            {!canManage && status.enabled && (
              <div className="credential-notice">
                Your Viewer role can inspect credential status, but only an
                Administrator or Operator can generate or rotate a key.
              </div>
            )}
          </>
        )}

        {secret && (
          <div className="credential-secret">
            <div className="credential-secret__heading">
              <div>
                <span className="eyebrow">One-time secret</span>
                <strong>Save this key now</strong>
              </div>

              <button
                type="button"
                className="credential-icon-button"
                onClick={() => {
                  setSecret(null);
                  setCopied(null);
                }}
                aria-label="Hide device key"
              >
                <EyeOff size={17} />
              </button>
            </div>

            <p>
              This complete key will disappear when you close the panel, refresh
              the page, switch cameras or after five minutes. It cannot be
              recovered later.
            </p>

            <code className="credential-secret__value">{secret.deviceKey}</code>

            <div className="credential-secret__actions">
              <button
                type="button"
                onClick={() => void handleCopy("key", secret.deviceKey)}
              >
                {copied === "key" ? <Check size={16} /> : <Copy size={16} />}
                {copied === "key" ? "Key copied" : "Copy key"}
              </button>

              <button
                type="button"
                onClick={() => void handleCopy("command", simulatorCommand)}
              >
                {copied === "command" ? (
                  <Check size={16} />
                ) : (
                  <TerminalSquare size={16} />
                )}
                {copied === "command"
                  ? "Command copied"
                  : "Copy simulator command"}
              </button>
            </div>

            <small className="credential-secret__hint">
              The simulator command prompts for the key securely and does not
              place the secret in shell history.
            </small>
          </div>
        )}

        {error && <div className="credential-error">{error}</div>}
      </div>
    </section>
  );
}
