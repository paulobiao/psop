import {
  Check,
  Clipboard,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  beginMfaSetup,
  disableMfa,
  enableMfa,
  getMfaStatus,
  regenerateMfaRecoveryCodes,
  type MfaSetup,
  type MfaStatus,
} from './api';

interface SecuritySettingsPanelProps {
  onClose: () => void;
}

export default function SecuritySettingsPanel({
  onClose,
}: SecuritySettingsPanelProps) {
  const [status, setStatus] =
    useState<MfaStatus | null>(null);

  const [setup, setSetup] =
    useState<MfaSetup | null>(null);

  const [
    recoveryCodes,
    setRecoveryCodes,
  ] = useState<string[]>([]);

  const [
    setupCode,
    setSetupCode,
  ] = useState('');

  const [
    recoveryPassword,
    setRecoveryPassword,
  ] = useState('');

  const [
    recoveryVerificationCode,
    setRecoveryVerificationCode,
  ] = useState('');

  const [
    disablePassword,
    setDisablePassword,
  ] = useState('');

  const [
    disableVerificationCode,
    setDisableVerificationCode,
  ] = useState('');

  const [loading, setLoading] =
    useState(true);

  const [
    submittingAction,
    setSubmittingAction,
  ] = useState<string | null>(null);

  const [copied, setCopied] =
    useState<string | null>(null);

  const [error, setError] =
    useState<string | null>(null);

  const [success, setSuccess] =
    useState<string | null>(null);

  const loadStatus =
    useCallback(async () => {
      setLoading(true);

      try {
        const result =
          await getMfaStatus();

        setStatus(result);
        setError(null);
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : 'Unable to load security settings',
        );
      } finally {
        setLoading(false);
      }
    }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

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

    return () => {
      window.removeEventListener(
        'keydown',
        handleKeyDown,
      );
    };
  }, [onClose]);

  async function handleBeginSetup() {
    setSubmittingAction('setup');
    setError(null);
    setSuccess(null);
    setRecoveryCodes([]);

    try {
      const result =
        await beginMfaSetup();

      setSetup(result);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to begin MFA setup',
      );
    } finally {
      setSubmittingAction(null);
    }
  }

  async function handleEnableMfa(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    setSubmittingAction('enable');
    setError(null);
    setSuccess(null);

    try {
      const result =
        await enableMfa(setupCode);

      setRecoveryCodes(
        result.recoveryCodes,
      );

      setSetup(null);
      setSetupCode('');

      await loadStatus();

      window.dispatchEvent(
        new Event(
          'psop:auth-changed',
        ),
      );

      setSuccess(
        'Two-factor authentication is now enabled.',
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to enable two-factor authentication',
      );
    } finally {
      setSubmittingAction(null);
    }
  }

  async function handleRegenerateCodes(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    const confirmed =
      window.confirm(
        'Replace all existing recovery codes? Existing codes will immediately stop working.',
      );

    if (!confirmed) {
      return;
    }

    setSubmittingAction('recovery');
    setError(null);
    setSuccess(null);

    try {
      const result =
        await regenerateMfaRecoveryCodes(
          recoveryPassword,
          recoveryVerificationCode,
        );

      setRecoveryCodes(
        result.recoveryCodes,
      );

      setRecoveryPassword('');
      setRecoveryVerificationCode('');

      await loadStatus();

      setSuccess(
        'New recovery codes were generated. Previous codes no longer work.',
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to regenerate recovery codes',
      );
    } finally {
      setSubmittingAction(null);
    }
  }

  async function handleDisableMfa(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    const confirmed =
      window.confirm(
        'Disable two-factor authentication for your PSOP account?',
      );

    if (!confirmed) {
      return;
    }

    setSubmittingAction('disable');
    setError(null);
    setSuccess(null);

    try {
      await disableMfa(
        disablePassword,
        disableVerificationCode,
      );

      setDisablePassword('');
      setDisableVerificationCode('');
      setRecoveryCodes([]);
      setSetup(null);

      await loadStatus();

      window.dispatchEvent(
        new Event(
          'psop:auth-changed',
        ),
      );

      setSuccess(
        'Two-factor authentication has been disabled.',
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to disable two-factor authentication',
      );
    } finally {
      setSubmittingAction(null);
    }
  }

  async function copyValue(
    value: string,
    label: string,
  ) {
    try {
      await navigator.clipboard
        .writeText(value);

      setCopied(label);

      window.setTimeout(() => {
        setCopied(null);
      }, 1600);
    } catch {
      setError(
        'Unable to copy to the clipboard',
      );
    }
  }

  return (
    <div
      className="security-settings-overlay"
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
        className="security-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Security settings"
      >
        <header className="security-settings-header">
          <div className="security-settings-title">
            <span className="security-settings-title__icon">
              <KeyRound size={22} />
            </span>

            <div>
              <span className="eyebrow">
                Account protection
              </span>

              <h2>
                Security settings
              </h2>

              <p>
                Protect your PSOP account
                with an authenticator
                application and one-time
                recovery codes.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="security-close-button"
            onClick={onClose}
            aria-label="Close security settings"
            title="Close"
          >
            <X size={20} />
          </button>
        </header>

        {(error || success) && (
          <div
            className={
              error
                ? 'security-message security-message--error'
                : 'security-message security-message--success'
            }
          >
            {error ?? success}
          </div>
        )}

        {loading || !status ? (
          <div className="security-loading">
            <LoaderCircle
              className="spin"
              size={25}
            />

            Loading security settings…
          </div>
        ) : (
          <div className="security-settings-content">
            <section className="security-status-card">
              <span
                className={
                  status.enabled
                    ? 'security-status-icon security-status-icon--enabled'
                    : 'security-status-icon'
                }
              >
                {status.enabled ? (
                  <ShieldCheck
                    size={25}
                  />
                ) : (
                  <ShieldOff
                    size={25}
                  />
                )}
              </span>

              <div className="security-status-copy">
                <span className="eyebrow">
                  Two-factor authentication
                </span>

                <h3>
                  {status.enabled
                    ? 'Authenticator protection enabled'
                    : 'Authenticator protection disabled'}
                </h3>

                <p>
                  {status.enabled
                    ? `${status.recoveryCodeCount} unused recovery code(s) remain.`
                    : 'Enable 2FA to require a temporary code when signing in.'}
                </p>
              </div>

              {!status.enabled &&
                !setup && (
                  <button
                    type="button"
                    className="security-primary-button"
                    onClick={() => {
                      void handleBeginSetup();
                    }}
                    disabled={
                      submittingAction ===
                      'setup'
                    }
                  >
                    {submittingAction ===
                    'setup' ? (
                      <LoaderCircle
                        className="spin"
                        size={17}
                      />
                    ) : (
                      <KeyRound
                        size={17}
                      />
                    )}

                    Begin setup
                  </button>
                )}
            </section>

            {setup && (
              <section className="security-card">
                <div>
                  <span className="eyebrow">
                    Authenticator setup
                  </span>

                  <h3>
                    Add PSOP to your
                    authenticator app
                  </h3>

                  <p>
                    Open Google
                    Authenticator, Microsoft
                    Authenticator, Authy or
                    another compatible app.
                    Choose the manual setup
                    option and enter the key
                    below.
                  </p>
                </div>

                <div className="security-secret">
                  <code>
                    {setup.secret}
                  </code>

                  <button
                    type="button"
                    onClick={() => {
                      void copyValue(
                        setup.secret,
                        'secret',
                      );
                    }}
                  >
                    {copied ===
                    'secret' ? (
                      <Check size={16} />
                    ) : (
                      <Clipboard
                        size={16}
                      />
                    )}

                    {copied ===
                    'secret'
                      ? 'Copied'
                      : 'Copy key'}
                  </button>
                </div>

                <div className="security-setup-details">
                  <span>
                    Type: time-based
                  </span>

                  <span>
                    Digits: 6
                  </span>

                  <span>
                    Interval: 30 seconds
                  </span>
                </div>

                <form
                  className="security-enable-form"
                  onSubmit={
                    handleEnableMfa
                  }
                >
                  <label>
                    <span>
                      Code shown in the app
                    </span>

                    <input
                      value={setupCode}
                      onChange={(event) => {
                        setSetupCode(
                          event.target.value,
                        );
                      }}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="000000"
                      minLength={6}
                      maxLength={6}
                      required
                      autoFocus
                    />
                  </label>

                  <button
                    type="submit"
                    className="security-primary-button"
                    disabled={
                      submittingAction ===
                      'enable'
                    }
                  >
                    {submittingAction ===
                    'enable' ? (
                      <LoaderCircle
                        className="spin"
                        size={17}
                      />
                    ) : (
                      <ShieldCheck
                        size={17}
                      />
                    )}

                    Verify and enable
                  </button>
                </form>
              </section>
            )}

            {recoveryCodes.length >
              0 && (
              <section className="security-card security-recovery-card">
                <div>
                  <span className="eyebrow">
                    Store these safely
                  </span>

                  <h3>
                    Recovery codes
                  </h3>

                  <p>
                    Each code works only
                    once. Store them outside
                    PSOP before closing this
                    window.
                  </p>
                </div>

                <div className="security-code-grid">
                  {recoveryCodes.map(
                    (recoveryCode) => (
                      <code
                        key={recoveryCode}
                      >
                        {recoveryCode}
                      </code>
                    ),
                  )}
                </div>

                <button
                  type="button"
                  className="security-secondary-button"
                  onClick={() => {
                    void copyValue(
                      recoveryCodes.join(
                        '\n',
                      ),
                      'recovery',
                    );
                  }}
                >
                  {copied ===
                  'recovery' ? (
                    <Check size={16} />
                  ) : (
                    <Clipboard
                      size={16}
                    />
                  )}

                  {copied ===
                  'recovery'
                    ? 'Codes copied'
                    : 'Copy all codes'}
                </button>
              </section>
            )}

            {status.enabled && (
              <div className="security-actions-grid">
                <form
                  className="security-management-card"
                  onSubmit={
                    handleRegenerateCodes
                  }
                >
                  <RefreshCw size={22} />

                  <div>
                    <h3>
                      Replace recovery
                      codes
                    </h3>

                    <p>
                      Existing recovery
                      codes will immediately
                      stop working.
                    </p>
                  </div>

                  <input
                    type="password"
                    value={
                      recoveryPassword
                    }
                    onChange={(event) => {
                      setRecoveryPassword(
                        event.target.value,
                      );
                    }}
                    autoComplete="current-password"
                    placeholder="Current password"
                    required
                  />

                  <input
                    value={
                      recoveryVerificationCode
                    }
                    onChange={(event) => {
                      setRecoveryVerificationCode(
                        event.target.value
                          .toUpperCase(),
                      );
                    }}
                    autoComplete="one-time-code"
                    placeholder="Authenticator or recovery code"
                    required
                  />

                  <button
                    type="submit"
                    className="security-secondary-button"
                    disabled={
                      submittingAction ===
                      'recovery'
                    }
                  >
                    {submittingAction ===
                    'recovery' ? (
                      <LoaderCircle
                        className="spin"
                        size={17}
                      />
                    ) : (
                      <RefreshCw
                        size={17}
                      />
                    )}

                    Regenerate codes
                  </button>
                </form>

                <form
                  className="security-management-card security-management-card--danger"
                  onSubmit={
                    handleDisableMfa
                  }
                >
                  <ShieldOff size={22} />

                  <div>
                    <h3>
                      Disable two-factor
                      authentication
                    </h3>

                    <p>
                      Your account will
                      return to password-only
                      authentication.
                    </p>
                  </div>

                  <input
                    type="password"
                    value={
                      disablePassword
                    }
                    onChange={(event) => {
                      setDisablePassword(
                        event.target.value,
                      );
                    }}
                    autoComplete="current-password"
                    placeholder="Current password"
                    required
                  />

                  <input
                    value={
                      disableVerificationCode
                    }
                    onChange={(event) => {
                      setDisableVerificationCode(
                        event.target.value
                          .toUpperCase(),
                      );
                    }}
                    autoComplete="one-time-code"
                    placeholder="Authenticator or recovery code"
                    required
                  />

                  <button
                    type="submit"
                    className="security-danger-button"
                    disabled={
                      submittingAction ===
                      'disable'
                    }
                  >
                    {submittingAction ===
                    'disable' ? (
                      <LoaderCircle
                        className="spin"
                        size={17}
                      />
                    ) : (
                      <ShieldOff
                        size={17}
                      />
                    )}

                    Disable 2FA
                  </button>
                </form>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
