import {
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
  getAccessToken,
  getCurrentUser,
  login,
  setAccessToken,
  type AuthUser,
} from './api';

interface AuthGateProps {
  children: ReactNode;
}

const AuthUserContext =
  createContext<AuthUser | null>(null);

export function useAuthUser(): AuthUser {
  const user = useContext(AuthUserContext);

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
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(
    Boolean(getAccessToken()),
  );
  const [submitting, setSubmitting] = useState(false);
  const [email, setEmail] = useState('admin@psop.local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = getAccessToken();

    if (!token) {
      setChecking(false);
      return;
    }

    const controller = new AbortController();

    void getCurrentUser(controller.signal)
      .then((currentUser) => {
        setUser(currentUser);
        setError(null);
      })
      .catch(() => {
        clearAccessToken();
        setUser(null);
      })
      .finally(() => setChecking(false));

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => {
      clearAccessToken();
      setUser(null);
      setChecking(false);
    };

    window.addEventListener(
      'psop:unauthorized',
      handleUnauthorized,
    );

    return () =>
      window.removeEventListener(
        'psop:unauthorized',
        handleUnauthorized,
      );
  }, []);

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const result = await login(email, password);

      setAccessToken(result.accessToken);
      setUser(result.user);
      setPassword('');
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

  function handleLogout() {
    clearAccessToken();
    setUser(null);
    setPassword('');
  }

  if (checking) {
    return (
      <main className="auth-loading">
        <LoaderCircle className="spin" size={30} />
        <strong>Validating secure session…</strong>
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
                Physical Security Observability Platform
              </small>
            </div>
          </div>

          <div className="auth-heading">
            <span className="eyebrow">
              Secure operations access
            </span>
            <h1>Sign in to PSOP</h1>
            <p>
              Access camera health, operational alerts and
              monitored locations.
            </p>
          </div>

          <form
            className="auth-form"
            onSubmit={handleSubmit}
          >
            <label>
              <span>Email address</span>

              <div className="auth-input">
                <Mail size={17} />
                <input
                  type="email"
                  value={email}
                  onChange={(event) =>
                    setEmail(event.target.value)
                  }
                  autoComplete="username"
                  required
                />
              </div>
            </label>

            <label>
              <span>Password</span>

              <div className="auth-input">
                <LockKeyhole size={17} />
                <input
                  type="password"
                  value={password}
                  onChange={(event) =>
                    setPassword(event.target.value)
                  }
                  autoComplete="current-password"
                  required
                  autoFocus
                />
              </div>
            </label>

            {error && (
              <div className="auth-error">{error}</div>
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
        </section>
      </main>
    );
  }

  return (
    <AuthUserContext.Provider value={user}>
      <>
        {children}

        <aside className="session-control">
        <ShieldCheck size={17} />

        <div>
          <strong>{user.name}</strong>
          <small>{user.role}</small>
        </div>

        <button
          type="button"
          onClick={handleLogout}
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOut size={16} />
        </button>
        </aside>
      </>
    </AuthUserContext.Provider>
  );
}
