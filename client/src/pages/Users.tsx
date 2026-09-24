import React, { useState } from 'react';
import useSWR, { mutate } from 'swr';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { PageHeader, Card, CardHeader, StatusBadge, EmptyState } from '../components/ui';

const API_URL = getApiBaseUrl();

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load data');
  return res.json();
};

export default function Users() {
  const { currentUser, role } = useAuth();
  const isAdminUI = role === 'ADMIN';
  // Managers run the team day-to-day (create packers, reset packer passwords,
  // link stations). Deletes, role choice, and non-packer targets stay admin.
  // Server re-checks every call; this only shapes the UI.
  const canManageTeam = isAdminUI || role === 'MANAGER';
  const isPackerRow = (u: any) => String(u?.role || '').toUpperCase() === 'PACKER';
  const { data: usersData, error, isLoading } = useSWR(canManageTeam ? `${API_URL}/api/admin/users` : null, fetcher, { refreshInterval: 30000 });
  const { data: stationsData } = useSWR(`${API_URL}/api/admin/stations`, fetcher);
  
  const users = usersData?.users || [];
  const stations = stationsData?.stations || [];
  
  const [isCreating, setIsCreating] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('packer');
  const [newPassword, setNewPassword] = useState('');
  const [createdCreds, setCreatedCreds] = useState<{ email: string; password: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState('');

  const [pwTarget, setPwTarget] = useState<{ id: string; email: string } | null>(null);
  const [pwValue, setPwValue] = useState('');
  const [pwShow, setPwShow] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);
  const [pwResult, setPwResult] = useState<{ email: string; password: string } | null>(null);

  function generatePassword(length = 12) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = new Uint32Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Clipboard unavailable — copy it manually');
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedPw = newPassword.trim();
    if (trimmedPw && trimmedPw.length < 6) {
      toast.error('Password must be at least 6 characters (or blank for random).');
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await authFetch(`${API_URL}/api/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, name: newName, role: isAdminUI ? newRole : 'packer', ...(trimmedPw ? { password: trimmedPw } : {}) })
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Failed to create user');
      setCreatedCreds({ email: newEmail, password: result.password });
      toast.success('User created — share the password now');
      mutate(`${API_URL}/api/admin/users`);
      setIsCreating(false);
      setNewEmail('');
      setNewName('');
      setNewPassword('');
    } catch (err: any) {
      toast.error(err.message || 'Error creating user');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateName = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await authFetch(`${API_URL}/api/users/me`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName })
      });
      if (!res.ok) throw new Error('Failed to update name');
      toast.success('Name updated successfully');
      mutate(`${API_URL}/api/admin/users`);
      setIsEditingName(false);
    } catch (err: any) {
      toast.error(err.message || 'Error updating name');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLinkStation = async (userId: string, stationId: string) => {
    try {
      const res = await authFetch(`${API_URL}/api/admin/users/${userId}/station`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stationId })
      });
      if (!res.ok) throw new Error('Failed to link station');
      toast.success('Station linked successfully');
      mutate(`${API_URL}/api/admin/users`);
    } catch (err: any) {
      toast.error(err.message || 'Error linking station');
    }
  };

  const openPwModal = (userId: string, email: string) => {
    setPwTarget({ id: userId, email });
    setPwValue('');
    setPwShow(false);
    setPwResult(null);
  };

  const closePwModal = () => {
    setPwTarget(null);
    setPwValue('');
    setPwShow(false);
    setPwResult(null);
  };

  const handleSavePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pwTarget) return;
    const trimmed = pwValue.trim();
    if (trimmed && trimmed.length < 6) {
      toast.error('Password must be at least 6 characters (or blank for random).');
      return;
    }
    setPwSaving(true);
    try {
      const res = await authFetch(`${API_URL}/api/admin/users/${pwTarget.id}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trimmed ? { password: trimmed } : {})
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Failed to set password');
      setPwResult({ email: pwTarget.email, password: result.password });
      setPwValue('');
      toast.success('Password updated — share it with the user now');
    } catch (err: any) {
      toast.error(err.message || 'Error setting password');
    } finally {
      setPwSaving(false);
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (!confirm('Are you sure you want to permanently delete this user?')) return;
    try {
      const res = await authFetch(`${API_URL}/api/admin/users/${userId}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error(await res.text() || 'Failed to delete user');
      toast.success('User deleted successfully');
      mutate(`${API_URL}/api/admin/users`);
    } catch (err: any) {
      toast.error(err.message || 'Error deleting user');
    }
  };


  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      {!canManageTeam ? (
        <main className="flex-1 overflow-y-auto p-gutter">
          <Card>
            <EmptyState
              icon="lock"
              title="Managers and admins only"
              hint="User management is restricted to admins and managers. Your packing and reporting access is unchanged."
            />
          </Card>
        </main>
      ) : (
      <>
      <PageHeader
        title="User Management"
        description={`${users.length} team users`}
        actions={
          <>
            <button
              onClick={() => {
                const myUser = users.find((u: any) => u.email === currentUser?.email);
                setEditName(myUser?.name || '');
                setIsEditingName(true);
              }}
              className="bg-surface-container text-on-surface px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 border border-border-subtle hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-sm">edit</span>
              Update My Name
            </button>
            <button
              onClick={() => setIsCreating(true)}
              className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 hover:bg-primary/90 transition-colors"
            >
              <span className="material-symbols-outlined text-sm">person_add</span>
              Create User
            </button>
          </>
        }
      />
      <main className="flex-1 p-gutter overflow-auto">
        {isLoading && (
          <Card>
            <EmptyState icon="progress_activity" title="Loading users..." hint="Fetching team members." />
          </Card>
        )}
        {error && (
          <Card className="p-4 border-critical/20 bg-critical/10 text-critical font-body-sm text-body-sm">
            <span className="flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">error</span>
              {error.message}
            </span>
          </Card>
        )}
        {!isLoading && !error && (
          <Card>
            <CardHeader
              icon="group"
              title="Team Users"
              description="Roles, default stations, and account actions"
              action={
                <span className="font-metadata text-metadata text-secondary shrink-0">{users.length} total</span>
              }
            />
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[800px]">
                <thead className="bg-surface-container-low border-b border-border-subtle">
                  <tr>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold uppercase tracking-wider">User</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold uppercase tracking-wider">Role</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold uppercase tracking-wider">Default Station</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold uppercase tracking-wider">Recordings</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold uppercase tracking-wider">Joined</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold uppercase tracking-wider text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user: any) => (
                    <tr key={user.id} className="border-b border-border-subtle last:border-0 hover:bg-surface-container-low transition-colors">
                      <td className="p-4 text-on-surface">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                            <span className="material-symbols-outlined text-sm">person</span>
                          </div>
                          <div className="min-w-0">
                            <p className="font-body-sm text-body-sm font-medium text-on-surface truncate">{user.name || 'Unknown User'}</p>
                            <p className="font-metadata text-metadata text-secondary truncate">{user.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="p-4"><StatusBadge status={user.role} /></td>
                      <td className="p-4">
                        <select
                          className="bg-surface-container-lowest border border-border-subtle rounded-lg px-2 py-1.5 text-sm text-on-surface w-40 focus:ring-2 focus:ring-primary focus:outline-none"
                          value={user.default_station_id || ''}
                          onChange={(e) => handleLinkStation(user.id, e.target.value)}
                        >
                          <option value="">-- None --</option>
                          {stations.map((s: any) => (
                            <option key={s.id} value={s.id}>{s.code} {s.name ? `(${s.name})` : ''}</option>
                          ))}
                        </select>
                      </td>
                      <td className="p-4 font-technical text-technical text-on-surface">{user.recordings}</td>
                      <td className="p-4 font-body-sm text-body-sm text-secondary whitespace-nowrap">{new Date(user.created_at).toLocaleDateString()}</td>
                      <td className="p-4 text-right">
                        {currentUser?.email !== user.email && (
                          <div className="flex items-center justify-end gap-1">
                            {(isAdminUI || isPackerRow(user)) && (
                            <button
                              onClick={() => openPwModal(user.id, user.email)}
                              title="Set Password"
                              className="p-2 rounded-lg text-secondary hover:text-primary hover:bg-primary/10 transition-colors"
                            >
                              <span className="material-symbols-outlined text-sm">lock_reset</span>
                            </button>
                            )}
                            {isAdminUI && (
                            <button
                              onClick={() => handleDeleteUser(user.id)}
                              title="Delete User"
                              className="p-2 rounded-lg text-secondary hover:text-critical hover:bg-critical/10 transition-colors"
                            >
                              <span className="material-symbols-outlined text-sm">delete</span>
                            </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {users.length === 0 && (
              <EmptyState
                icon="group"
                title="No users found."
                hint="Create your first team user to get started."
                action={
                  <button
                    onClick={() => setIsCreating(true)}
                    className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 hover:bg-primary/90 transition-colors"
                  >
                    <span className="material-symbols-outlined text-sm">person_add</span>
                    Create User
                  </button>
                }
              />
            )}
          </Card>
        )}

        {isCreating && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <Card className="w-full max-w-md">
              <CardHeader
                icon="person_add"
                title="Create User"
                description="Invite a new team member"
                action={
                  <button onClick={() => setIsCreating(false)} className="p-2 rounded-lg text-secondary hover:text-on-surface hover:bg-surface-container transition-colors" title="Close" aria-label="Close invite dialog">
                    <span className="material-symbols-outlined" aria-hidden="true">close</span>
                  </button>
                }
              />
              <form onSubmit={handleCreate} className="p-5 flex flex-col gap-4">
                <div>
                  <label className="block font-body-sm text-body-sm font-medium text-on-surface mb-1">Name</label>
                  <input
                    type="text"
                    required
                    placeholder="John Doe"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    className="w-full bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 font-body-sm text-body-sm text-on-surface focus:ring-2 focus:ring-primary focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-body-sm text-body-sm font-medium text-on-surface mb-1">Email Address</label>
                  <input
                    type="email"
                    required
                    placeholder="packer@example.com"
                    value={newEmail}
                    onChange={e => setNewEmail(e.target.value)}
                    className="w-full bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 font-body-sm text-body-sm text-on-surface focus:ring-2 focus:ring-primary focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-body-sm text-body-sm font-medium text-on-surface mb-1">Role</label>
                  {isAdminUI ? (
                  <select
                    value={newRole}
                    onChange={e => setNewRole(e.target.value)}
                    className="w-full bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 font-body-sm text-body-sm text-on-surface focus:ring-2 focus:ring-primary focus:outline-none"
                  >
                    <option value="packer">Packer (Station Only)</option>
                    <option value="manager">Manager (Reports & Search)</option>
                    <option value="admin">Admin (Full Access)</option>
                  </select>
                  ) : (
                    <p className="font-body-sm text-body-sm text-secondary">Packer (Station Only) — managers can only create packer accounts.</p>
                  )}
                </div>
                <div>
                  <label className="block font-body-sm text-body-sm font-medium text-on-surface mb-1">Password (optional)</label>
                  <input
                    type="text"
                    placeholder="Blank = random"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="w-full bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 font-body-sm text-body-sm text-on-surface focus:ring-2 focus:ring-primary focus:outline-none"
                  />
                </div>
                <p className="font-body-sm text-body-sm text-secondary italic flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-sm">info</span>
                  Min 6 characters. The password is shown once after create — share it with the user then.
                </p>
                <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-2">
                  <button
                    type="button"
                    onClick={() => setIsCreating(false)}
                    className="px-4 py-2 rounded-lg font-medium text-sm text-secondary hover:bg-surface-container-high transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {isSubmitting ? 'Creating...' : 'Create'}
                  </button>
                </div>
              </form>
            </Card>
          </div>
        )}

        {createdCreds && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <Card className="w-full max-w-md">
              <CardHeader
                icon="key"
                title="User created"
                description="Share this password now — it won't be shown again"
              />
              <div className="p-5 flex flex-col gap-3">
                <p className="font-body-sm text-body-sm text-on-surface">{createdCreds.email}</p>
                <div className="flex items-center gap-2 rounded-lg bg-surface-container-low border border-border-subtle px-3 py-2.5">
                  <p className="flex-1 font-technical text-technical text-on-surface break-all">{createdCreds.password}</p>
                  <button
                    type="button"
                    onClick={() => copyText(createdCreds.password)}
                    className="p-1.5 rounded-lg text-secondary hover:text-primary hover:bg-primary/10 transition-colors"
                    title="Copy password"
                  >
                    <span className="material-symbols-outlined text-sm">content_copy</span>
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setCreatedCreds(null)}
                  className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium text-sm hover:bg-primary/90 transition-colors"
                >
                  Done
                </button>
              </div>
            </Card>
          </div>
        )}

        {pwTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <Card className="w-full max-w-md">
              <CardHeader
                icon="lock_reset"
                title="Set Password"
                description={pwTarget.email}
                action={
                  <button onClick={closePwModal} className="p-2 rounded-lg text-secondary hover:text-on-surface hover:bg-surface-container transition-colors" title="Close" aria-label="Close password dialog">
                    <span className="material-symbols-outlined" aria-hidden="true">close</span>
                  </button>
                }
              />
              {pwResult ? (
                <div className="p-5 flex flex-col gap-3">
                  <p className="font-body-sm text-body-sm text-on-surface">New password for <span className="font-medium">{pwResult.email}</span> — share it now, it won't be shown again.</p>
                  <div className="flex items-center gap-2 rounded-lg bg-surface-container-low border border-border-subtle px-3 py-2.5">
                    <p className="flex-1 font-technical text-technical text-on-surface break-all">{pwResult.password}</p>
                    <button
                      type="button"
                      onClick={() => copyText(pwResult.password)}
                      className="p-1.5 rounded-lg text-secondary hover:text-primary hover:bg-primary/10 transition-colors"
                      title="Copy password"
                    >
                      <span className="material-symbols-outlined text-sm">content_copy</span>
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={closePwModal}
                    className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium text-sm hover:bg-primary/90 transition-colors"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSavePassword} className="p-5 flex flex-col gap-4">
                  <div>
                    <label className="block font-body-sm text-body-sm font-medium text-on-surface mb-1">New password</label>
                    <div className="relative">
                      <input
                        type={pwShow ? 'text' : 'password'}
                        value={pwValue}
                        onChange={(e) => setPwValue(e.target.value)}
                        placeholder="Blank = random"
                        autoFocus
                        className="w-full bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 pr-10 font-body-sm text-body-sm text-on-surface focus:ring-2 focus:ring-primary focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setPwShow((s) => !s)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-secondary hover:text-primary transition-colors"
                        title={pwShow ? 'Hide' : 'Show'}
                      >
                        <span className="material-symbols-outlined text-sm">{pwShow ? 'visibility_off' : 'visibility'}</span>
                      </button>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <p className="font-body-sm text-body-sm text-secondary">Min 6 characters. Blank generates a random one.</p>
                      <button
                        type="button"
                        onClick={() => setPwValue(generatePassword())}
                        className="text-primary text-body-sm font-medium hover:underline shrink-0"
                      >
                        Generate
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-1">
                    <button
                      type="button"
                      onClick={closePwModal}
                      className="px-4 py-2 rounded-lg font-medium text-sm text-secondary hover:bg-surface-container-high transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={pwSaving}
                      className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {pwSaving ? 'Saving...' : 'Set Password'}
                    </button>
                  </div>
                </form>
              )}
            </Card>
          </div>
        )}

        {isEditingName && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <Card className="w-full max-w-sm">
              <CardHeader
                icon="edit"
                title="Update My Name"
                description="Change your display name"
                action={
                  <button onClick={() => setIsEditingName(false)} className="p-2 rounded-lg text-secondary hover:text-on-surface hover:bg-surface-container transition-colors" title="Close" aria-label="Close display name dialog">
                    <span className="material-symbols-outlined" aria-hidden="true">close</span>
                  </button>
                }
              />
              <form onSubmit={handleUpdateName} className="p-5 flex flex-col gap-4">
                <div>
                  <label className="block font-body-sm text-body-sm font-medium text-on-surface mb-1">Full Name</label>
                  <input
                    type="text"
                    required
                    placeholder="Your Name"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    className="w-full bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 font-body-sm text-body-sm text-on-surface focus:ring-2 focus:ring-primary focus:outline-none"
                  />
                </div>
                <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-2">
                  <button
                    type="button"
                    onClick={() => setIsEditingName(false)}
                    className="px-4 py-2 rounded-lg font-medium text-sm text-secondary hover:bg-surface-container-high transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {isSubmitting ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </form>
            </Card>
          </div>
        )}
      </main>
      </>
      )}
    </div>
  );
}
