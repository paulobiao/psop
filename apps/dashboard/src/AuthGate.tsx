import {
  ArrowLeft,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';
import {
  clearAccessToken,
  completeFirstPasswordChange,
  getCurrentUser,
  login,
  logoutCurrentSession,
  setAccessToken,
  verifyMfaLogin,
  type AuthUser,
  type LoginResponse,
} from './api';
import SecuritySettingsPanel from './SecuritySettingsPanel';

interface AuthGateProps {
  children: ReactNode;
}

type AuthenticationStage =
  | 'LOGIN'
  | 'PASSWORD_CHANGE'
  | 'MFA';

const AuthUserContext =
  createContext<AuthUser | null>(null);

export function useAuthUser(): AuthUser {
  const user =
    useContext(AuthUserContext);

  if (!user) {
    throw new Error(
      'Authenticated user context is unavailable',
    );
  }

  return user;
}

export default function AuthGate({
  children,
}: AuthGateProps) {
  const [user, setUser] =
    useState<AuthUser | null>(null);

  const [checking, setChecking] =
    useState(true);

  const [submitting, setSubmitting] =
    useState(false);

  const [loggingOut, setLoggingOut] =
    useState(false);


  const [
    securitySettingsOpen,
    setSecuritySettingsOpen,
  ] = useState(false);

  const [stage, setStage] =
    useState<AuthenticationStage>(
      'LOGIN',
    );

  const [email, setEmail] =
    useState('admin@psop.local');

  const [password, setPassword] =
    useState('');

  const [
    challengeToken,
    setChallengeToken,
  ] = useState('');

  const [
    pendingUserName,
    setPendingUserName,
  ] = useState('');

  const [
    newPassword,
    setNewPassword,
  ] = useState('');

  const [
    passwordConfirmation,
    setPasswordConfirmation,
  ] = useState('');

  const [mfaCode, setMfaCode] =
    useState('');

  const [error, setError] =
    useState<string | null>(null);

  useEffect(() => {
    const controller =
      new AbortController();

    void getCurrentUser(
      controller.signal,
    )
      .then((currentUser) => {
        setUser(currentUser);
        setError(null);
      })
      .catch(() => {
        clearAccessToken();
        setUser(null);
      })
      .finally(() => {
        setChecking(false);
      });

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => {
      clearAccessToken();
      setUser(null);
      resetAuthenticationFlow();
      setChecking(false);
    };

    const handleAuthenticationChanged =
      () => {
        void getCurrentUser()
          .then((currentUser) => {
            setUser(currentUser);
          })
          .catch(() => undefined);
      };

    window.addEventListener(
      'psop:unauthorized',
      handleUnauthorized,
    );

    window.addEventListener(
      'psop:auth-changed',
      handleAuthenticationChanged,
    );

    return () => {
      window.removeEventListener(
        'psop:unauthorized',
        handleUnauthorized,
      );

      window.removeEventListener(
        'psop:auth-changed',
        handleAuthenticationChanged,
      );
    };
  }, []);

  function applyAuthenticationResult(
    result: LoginResponse,
  ): void {
    if (
      result.stage ===
      'AUTHENTICATED'
    ) {
      setAccessToken(
        result.accessToken,
      );

      setUser(result.user);
      setPassword('');
      setMfaCode('');
      setChallengeToken('');
      setStage('LOGIN');

      return;
    }

    setChallengeToken(
      result.challengeToken,
    );

    setPendingUserName(
      result.user.name,
    );

    setStage(
      result.stage ===
      'PASSWORD_CHANGE_REQUIRED'
        ? 'PASSWORD_CHANGE'
        : 'MFA',
    );
  }

  async function handleLogin(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    setSubmitting(true);
    setError(null);

    try {
      const result = await login(
        email,
        password,
      );

      applyAuthenticationResult(
        result,
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to sign in',
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePasswordChange(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    setError(null);

    if (
      newPassword !==
      passwordConfirmation
    ) {
      setError(
        'The passwords do not match',
      );

      return;
    }

    setSubmitting(true);

    try {
      const result =
        await completeFirstPasswordChange(
          challengeToken,
          newPassword,
        );

      setPassword('');
      setNewPassword('');
      setPasswordConfirmation('');

      applyAuthenticationResult(
        result,
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to change password',
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMfaVerification(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    setSubmitting(true);
    setError(null);

    try {
      const result =
        await verifyMfaLogin(
          challengeToken,
          mfaCode,
        );

      applyAuthenticationResult(
        result,
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Invalid authentication code',
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    setLoggingOut(true);

    try {
      await logoutCurrentSession();
    } catch {
      clearAccessToken();
    } finally {
      clearAccessToken();
      setUser(null);
      setPassword('');
      resetAuthenticationFlow();
      setLoggingOut(false);
    }
  }

  function resetAuthenticationFlow() {
    setStage('LOGIN');
    setChallengeToken('');
    setPendingUserName('');
    setNewPassword('');
    setPasswordConfirmation('');
    setMfaCode('');
    setError(null);
  }

  if (checking) {
    return (
      <main className="auth-loading">
        <LoaderCircle
          className="spin"
          size={30}
        />

        <strong>
          Validating secure session…
        </strong>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <div className="auth-brand">
            <ShieldCheck size={28} />

            <div>
              <strong>PSOP</strong>

              <small>
                Physical Security
                Observability Platform
              </small>
            </div>
          </div>

          {stage === 'LOGIN' && (
            <>
              <div className="auth-heading">
                <span className="eyebrow">
                  Secure operations access
                </span>

                <h1>
                  Sign in to PSOP
                </h1>

                <p>
                  Access camera health,
                  operational alerts and
                  monitored locations.
                </p>
              </div>

              <form
                className="auth-form"
                onSubmit={handleLogin}
              >
                <label>
                  <span>
                    Email address
                  </span>

                  <div className="auth-input">
                    <Mail size={17} />

                    <input
                      type="email"
                      value={email}
                      onChange={(event) =>
                        setEmail(
                          event.target.value,
                        )
                      }
                      autoComplete="username"
                      required
                    />
                  </div>
                </label>

                <label>
                  <span>Password</span>

                  <div className="auth-input">
                    <LockKeyhole
                      size={17}
                    />

                    <input
                      type="password"
                      value={password}
                      onChange={(event) =>
                        setPassword(
                          event.target.value,
                        )
                      }
                      autoComplete="current-password"
                      required
                      autoFocus
                    />
                  </div>
                </label>

                {error && (
                  <div className="auth-error">
                    {error}
                  </div>
                )}

                <button
                  className="auth-submit"
                  type="submit"
                  disabled={submitting}
                >
                  {submitting ? (
                    <LoaderCircle
                      className="spin"
                      size={18}
                    />
                  ) : (
                    <LogIn size={18} />
                  )}

                  {submitting
                    ? 'Signing in…'
                    : 'Sign in securely'}
                </button>
              </form>
            </>
          )}

          {stage ===
            'PASSWORD_CHANGE' && (
            <>
              <div className="auth-heading">
                <span className="eyebrow">
                  First access
                </span>

                <h1>
                  Create your password
                </h1>

                <p>
                  Welcome,
                  {' '}
                  {pendingUserName}.
                  Replace the temporary
                  password before accessing
                  PSOP.
                </p>
              </div>

              <form
                className="auth-form"
                onSubmit={
                  handlePasswordChange
                }
              >
                <label>
                  <span>
                    New password
                  </span>

                  <div className="auth-input">
                    <LockKeyhole
                      size={17}
                    />

                    <input
                      type="password"
                      value={newPassword}
                      onChange={(event) =>
                        setNewPassword(
                          event.target.value,
                        )
                      }
                      minLength={12}
                      autoComplete="new-password"
                      required
                      autoFocus
                    />
                  </div>
                </label>

                <label>
                  <span>
                    Confirm password
                  </span>

                  <div className="auth-input">
                    <LockKeyhole
                      size={17}
                    />

                    <input
                      type="password"
                      value={
                        passwordConfirmation
                      }
                      onChange={(event) =>
                        setPasswordConfirmation(
                          event.target.value,
                        )
                      }
                      minLength={12}
                      autoComplete="new-password"
                      required
                    />
                  </div>
                </label>

                {error && (
                  <div className="auth-error">
                    {error}
                  </div>
                )}

                <button
                  className="auth-submit"
                  type="submit"
                  disabled={submitting}
                >
                  {submitting ? (
                    <LoaderCircle
                      className="spin"
                      size={18}
                    />
                  ) : (
                    <KeyRound size={18} />
                  )}

                  Set password
                </button>
              </form>
            </>
          )}

          {stage === 'MFA' && (
            <>
              <div className="auth-heading">
                <span className="eyebrow">
                  Two-factor authentication
                </span>

                <h1>
                  Verify your identity
                </h1>

                <p>
                  Enter the six-digit code
                  from your authenticator
                  app or one unused recovery
                  code.
                </p>
              </div>

              <form
                className="auth-form"
                onSubmit={
                  handleMfaVerification
                }
              >
                <label>
                  <span>
                    Authentication code
                  </span>

                  <div className="auth-input">
                    <KeyRound size={17} />

                    <input
                      value={mfaCode}
                      onChange={(event) =>
                        setMfaCode(
                          event.target.value
                            .toUpperCase(),
                        )
                      }
                      autoComplete="one-time-code"
                      placeholder="000000 or XXXX-XXXX"
                      required
                      autoFocus
                    />
                  </div>
                </label>

                {error && (
                  <div className="auth-error">
                    {error}
                  </div>
                )}

                <button
                  className="auth-submit"
                  type="submit"
                  disabled={submitting}
                >
                  {submitting ? (
                    <LoaderCircle
                      className="spin"
                      size={18}
                    />
                  ) : (
                    <ShieldCheck
                      size={18}
                    />
                  )}

                  Verify and sign in
                </button>
              </form>
            </>
          )}

          {stage !== 'LOGIN' && (
            <button
              className="auth-back-button"
              type="button"
              onClick={
                resetAuthenticationFlow
              }
            >
              <ArrowLeft size={15} />
              Return to sign in
            </button>
          )}
        </section>
      </main>
    );
  }

  return (
    <AuthUserContext.Provider
      value={user}
    >
      <>
        {children}

        <aside className="session-control">
          <ShieldCheck size={17} />

          <div>
            <strong>
              {user.name}
            </strong>

            <small>
              {user.role}
              {user.mfaEnabled
                ? ' · 2FA'
                : ''}
            </small>
          </div>

          <button
            type="button"
            onClick={() => {
              setSecuritySettingsOpen(
                true,
              );
            }}
            aria-label="Security settings"
            title="Security settings"
          >
            <KeyRound size={16} />
          </button>

          <button
            type="button"
            onClick={() =>
              void handleLogout()
            }
            disabled={loggingOut}
            aria-label="Sign out"
            title="Sign out"
          >
            {loggingOut ? (
              <LoaderCircle
                className="spin"
                size={16}
              />
            ) : (
              <LogOut size={16} />
            )}
          </button>
        </aside>

        {securitySettingsOpen && (
          <SecuritySettingsPanel
            onClose={() => {
              setSecuritySettingsOpen(
                false,
              );
            }}
          />
        )}
      </>
    </AuthUserContext.Provider>
  );
}
