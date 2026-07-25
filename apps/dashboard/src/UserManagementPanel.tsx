import {
  KeyRound,
  LoaderCircle,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  changeUserPassword,
  createUser,
  deleteUser,
  getUsers,
  updateUser,
  type ManagedUser,
  type ManagedUserRole,
  type ManagedUserStatus,
} from './api';

interface UserManagementPanelProps {
  currentUserId: string;
  onClose: () => void;
}

interface UserForm {
  name: string;
  email: string;
  role: ManagedUserRole;
  status: ManagedUserStatus;
}

const emptyForm: UserForm = {
  name: '',
  email: '',
  role: 'OPERATOR',
  status: 'ACTIVE',
};

function roleDescription(role: ManagedUserRole) {
  if (role === 'ADMIN') {
    return 'Full platform and user administration';
  }

  if (role === 'OPERATOR') {
    return 'Manage sites, devices and alerts';
  }

  return 'Read-only operational visibility';
}

function formatDate(value: string | null): string {
  if (!value) {
    return 'Never';
  }

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export default function UserManagementPanel({
  currentUserId,
  onClose,
}: UserManagementPanelProps) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [selectedUserId, setSelectedUserId] =
    useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<UserForm>(emptyForm);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] =
    useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] =
    useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);

    try {
      const result = await getUsers();

      setUsers(result);
      setSelectedUserId((current) => {
        if (
          current &&
          result.some((user) => user.id === current)
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
          : 'Unable to load users',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () =>
      window.removeEventListener(
        'keydown',
        handleKeyDown,
      );
  }, [onClose]);

  const selectedUser = useMemo(
    () =>
      users.find(
        (user) => user.id === selectedUserId,
      ) ?? null,
    [users, selectedUserId],
  );

  useEffect(() => {
    if (!selectedUser || creating) {
      return;
    }

    setForm({
      name: selectedUser.name,
      email: selectedUser.email,
      role: selectedUser.role,
      status: selectedUser.status,
    });
    setPassword('');
  }, [selectedUser, creating]);

  function selectUser(user: ManagedUser) {
    setCreating(false);
    setSelectedUserId(user.id);
    setError(null);
    setSuccess(null);
  }

  function startCreating() {
    setCreating(true);
    setSelectedUserId(null);
    setForm(emptyForm);
    setPassword('');
    setError(null);
    setSuccess(null);
  }

  async function handleCreate(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    setSubmitting('create');
    setError(null);
    setSuccess(null);

    try {
      const created = await createUser({
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        password,
        role: form.role,
      });

      await loadUsers();
      setCreating(false);
      setSelectedUserId(created.id);
      setPassword('');
      setSuccess(`User ${created.name} created.`);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to create user',
      );
    } finally {
      setSubmitting(null);
    }
  }

  async function handleUpdate(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    if (!selectedUser) {
      return;
    }

    setSubmitting('update');
    setError(null);
    setSuccess(null);

    try {
      const updated = await updateUser(
        selectedUser.id,
        {
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          role: form.role,
          status: form.status,
        },
      );

      await loadUsers();
      setSelectedUserId(updated.id);
      setSuccess(`User ${updated.name} updated.`);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to update user',
      );
    } finally {
      setSubmitting(null);
    }
  }

  async function handlePasswordReset() {
    if (!selectedUser) {
      return;
    }

    setSubmitting('password');
    setError(null);
    setSuccess(null);

    try {
      await changeUserPassword(
        selectedUser.id,
        password,
      );

      setPassword('');
      setSuccess(
        `Password updated for ${selectedUser.name}.`,
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to update password',
      );
    } finally {
      setSubmitting(null);
    }
  }

  async function handleRemove() {
    if (
      !selectedUser ||
      selectedUser.id === currentUserId
    ) {
      return;
    }

    const confirmed = window.confirm(
      `Remove ${selectedUser.name} from PSOP?`,
    );

    if (!confirmed) {
      return;
    }

    setSubmitting('delete');
    setError(null);
    setSuccess(null);

    try {
      await deleteUser(selectedUser.id);
      await loadUsers();
      setSuccess(
        `User ${selectedUser.name} removed.`,
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to remove user',
      );
    } finally {
      setSubmitting(null);
    }
  }

  const activeUsers = users.filter(
    (user) => user.status === 'ACTIVE',
  ).length;

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
        className="user-management-modal"
        role="dialog"
        aria-modal="true"
        aria-label="User management"
      >
        <header className="user-management-header">
          <div className="user-management-title">
            <span>
              <Users size={22} />
            </span>

            <div>
              <span className="eyebrow">
                Access administration
              </span>
              <h2>User management</h2>
              <p>
                Create accounts and control operational
                permissions for this organization.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close user management"
          >
            <X size={20} />
          </button>
        </header>

        <div className="user-management-summary">
          <article>
            <span>Total users</span>
            <strong>{users.length}</strong>
          </article>

          <article>
            <span>Active users</span>
            <strong>{activeUsers}</strong>
          </article>

          <article>
            <span>Administrators</span>
            <strong>
              {
                users.filter(
                  (user) =>
                    user.role === 'ADMIN' &&
                    user.status === 'ACTIVE',
                ).length
              }
            </strong>
          </article>
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

        <div className="user-management-layout">
          <aside className="user-management-list">
            <button
              type="button"
              className="user-create-button"
              onClick={startCreating}
            >
              <Plus size={17} />
              Add user
            </button>

            {loading ? (
              <div className="user-management-loading">
                <LoaderCircle
                  className="spin"
                  size={22}
                />
                Loading users…
              </div>
            ) : (
              <div className="user-list">
                {users.map((user) => (
                  <button
                    type="button"
                    key={user.id}
                    className={
                      !creating &&
                      selectedUserId === user.id
                        ? 'user-list-card user-list-card--active'
                        : 'user-list-card'
                    }
                    onClick={() => selectUser(user)}
                  >
                    <span className="user-avatar">
                      {user.name
                        .split(' ')
                        .slice(0, 2)
                        .map((part) => part[0])
                        .join('')
                        .toUpperCase()}
                    </span>

                    <div>
                      <strong>{user.name}</strong>
                      <small>{user.email}</small>

                      <span className="user-list-meta">
                        {user.role}
                        {' · '}
                        {user.status}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </aside>

          <main className="user-management-content">
            {creating ? (
              <form
                className="user-management-form"
                onSubmit={handleCreate}
              >
                <div className="user-form-heading">
                  <span>
                    <Plus size={20} />
                  </span>

                  <div>
                    <span className="eyebrow">
                      New account
                    </span>
                    <h3>Add a PSOP user</h3>
                  </div>
                </div>

                <div className="user-form-grid">
                  <label>
                    <span>Full name</span>
                    <input
                      value={form.name}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      required
                    />
                  </label>

                  <label>
                    <span>Email address</span>
                    <input
                      type="email"
                      value={form.email}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          email: event.target.value,
                        }))
                      }
                      required
                    />
                  </label>

                  <label>
                    <span>Access role</span>
                    <select
                      value={form.role}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          role: event.target
                            .value as ManagedUserRole,
                        }))
                      }
                    >
                      <option value="ADMIN">ADMIN</option>
                      <option value="OPERATOR">
                        OPERATOR
                      </option>
                      <option value="VIEWER">
                        VIEWER
                      </option>
                    </select>
                    <small>
                      {roleDescription(form.role)}
                    </small>
                  </label>

                  <label>
                    <span>Temporary password</span>
                    <input
                      type="password"
                      value={password}
                      onChange={(event) =>
                        setPassword(event.target.value)
                      }
                      minLength={12}
                      required
                    />
                    <small>
                      Minimum 12 characters
                    </small>
                  </label>
                </div>

                <div className="user-form-actions">
                  <button
                    type="button"
                    className="user-secondary-button"
                    onClick={() => {
                      setCreating(false);
                      setSelectedUserId(
                        users.at(0)?.id ?? null,
                      );
                    }}
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    className="user-primary-button"
                    disabled={submitting === 'create'}
                  >
                    {submitting === 'create' ? (
                      <LoaderCircle
                        className="spin"
                        size={17}
                      />
                    ) : (
                      <Plus size={17} />
                    )}
                    Create user
                  </button>
                </div>
              </form>
            ) : selectedUser ? (
              <div className="user-editor">
                <form
                  className="user-management-form"
                  onSubmit={handleUpdate}
                >
                  <div className="user-form-heading">
                    <span>
                      <UserCog size={20} />
                    </span>

                    <div>
                      <span className="eyebrow">
                        Account settings
                      </span>
                      <h3>{selectedUser.name}</h3>
                      <p>
                        Last sign-in:{' '}
                        {formatDate(
                          selectedUser.lastLoginAt,
                        )}
                      </p>
                    </div>
                  </div>

                  {selectedUser.id ===
                    currentUserId && (
                    <div className="user-current-account">
                      <ShieldCheck size={17} />
                      This is your current administrator
                      account.
                    </div>
                  )}

                  <div className="user-form-grid">
                    <label>
                      <span>Full name</span>
                      <input
                        value={form.name}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        required
                      />
                    </label>

                    <label>
                      <span>Email address</span>
                      <input
                        type="email"
                        value={form.email}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            email: event.target.value,
                          }))
                        }
                        required
                      />
                    </label>

                    <label>
                      <span>Access role</span>
                      <select
                        value={form.role}
                        disabled={
                          selectedUser.id === currentUserId
                        }
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            role: event.target
                              .value as ManagedUserRole,
                          }))
                        }
                      >
                        <option value="ADMIN">
                          ADMIN
                        </option>
                        <option value="OPERATOR">
                          OPERATOR
                        </option>
                        <option value="VIEWER">
                          VIEWER
                        </option>
                      </select>
                      <small>
                        {roleDescription(form.role)}
                      </small>
                    </label>

                    <label>
                      <span>Account status</span>
                      <select
                        value={form.status}
                        disabled={
                          selectedUser.id === currentUserId
                        }
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            status: event.target
                              .value as ManagedUserStatus,
                          }))
                        }
                      >
                        <option value="ACTIVE">
                          ACTIVE
                        </option>
                        <option value="DISABLED">
                          DISABLED
                        </option>
                      </select>
                    </label>
                  </div>

                  <div className="user-form-actions">
                    <button
                      type="button"
                      className="user-danger-button"
                      disabled={
                        selectedUser.id === currentUserId ||
                        submitting === 'delete'
                      }
                      onClick={() =>
                        void handleRemove()
                      }
                    >
                      <Trash2 size={16} />
                      Remove
                    </button>

                    <button
                      type="submit"
                      className="user-primary-button"
                      disabled={
                        submitting === 'update'
                      }
                    >
                      {submitting === 'update' ? (
                        <LoaderCircle
                          className="spin"
                          size={17}
                        />
                      ) : (
                        <Save size={17} />
                      )}
                      Save changes
                    </button>
                  </div>
                </form>

                <section className="user-password-panel">
                  <div>
                    <span className="eyebrow">
                      Security
                    </span>
                    <h3>Reset password</h3>
                    <p>
                      Set a new temporary password with at
                      least 12 characters.
                    </p>
                  </div>

                  <div className="user-password-control">
                    <div>
                      <KeyRound size={17} />
                      <input
                        type="password"
                        value={password}
                        placeholder="New temporary password"
                        onChange={(event) =>
                          setPassword(
                            event.target.value,
                          )
                        }
                        minLength={12}
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        void handlePasswordReset()
                      }
                      disabled={
                        password.length < 12 ||
                        submitting === 'password'
                      }
                    >
                      {submitting === 'password' ? (
                        <LoaderCircle
                          className="spin"
                          size={17}
                        />
                      ) : (
                        <KeyRound size={17} />
                      )}
                      Update password
                    </button>
                  </div>
                </section>
              </div>
            ) : (
              <div className="details-empty">
                <Users size={27} />
                <strong>No user selected</strong>
                <span>
                  Select an account or create a new user.
                </span>
              </div>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
