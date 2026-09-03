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
  const isAdminUI = role === null || role === 'ADMIN';
  const { data: usersData, error, isLoading } = useSWR(isAdminUI ? `${API_URL}/api/admin/users` : null, fetcher, { refreshInterval: 30000 });
  const { data: stationsData } = useSWR(`${API_URL}/api/admin/stations`, fetcher);
  
  const users = usersData?.users || [];
  const stations = stationsData?.stations || [];
  
  const [isCreating, setIsCreating] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('packer');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState('');

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await authFetch(`${API_URL}/api/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, name: newName, role: newRole })
      });
      if (!res.ok) throw new Error('Failed to create user');
      toast.success('User created with temporary password: Welcome@123');
      mutate(`${API_URL}/api/admin/users`);
      setIsCreating(false);
      setNewEmail('');
      setNewName('');
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

  const handleResetPassword = async (userId: string) => {
    if (!confirm('Are you sure you want to reset this user\'s password to Welcome@123 ?')) return;
    try {
      const res = await authFetch(`${API_URL}/api/admin/users/${userId}/reset-password`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error('Failed to reset password');
      toast.success('Password reset to Welcome@123');
    } catch (err: any) {
      toast.error(err.message || 'Error resetting password');
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
      {!isAdminUI ? (
        <main className="flex-1 overflow-y-auto p-gutter">
          <Card>
            <EmptyState
              icon="lock"
              title="Admins only"
              hint="User management is restricted to admins. Your packing and reporting access is unchanged."
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
                            <button
                              onClick={() => handleResetPassword(user.id)}
                              title="Reset Password"
                              className="p-2 rounded-lg text-secondary hover:text-primary hover:bg-primary/10 transition-colors"
                            >
                              <span className="material-symbols-outlined text-sm">lock_reset</span>
                            </button>
                            <button
                              onClick={() => handleDeleteUser(user.id)}
                              title="Delete User"
                              className="p-2 rounded-lg text-secondary hover:text-critical hover:bg-critical/10 transition-colors"
                            >
                              <span className="material-symbols-outlined text-sm">delete</span>
                            </button>
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
                  <button onClick={() => setIsCreating(false)} className="p-2 rounded-lg text-secondary hover:text-on-surface hover:bg-surface-container transition-colors" title="Close">
                    <span className="material-symbols-outlined">close</span>
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
                  <select
                    value={newRole}
                    onChange={e => setNewRole(e.target.value)}
                    className="w-full bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 font-body-sm text-body-sm text-on-surface focus:ring-2 focus:ring-primary focus:outline-none"
                  >
                    <option value="packer">Packer (Station Only)</option>
                    <option value="manager">Manager (Reports & Search)</option>
                    <option value="admin">Admin (Full Access)</option>
                  </select>
                </div>
                <p className="font-body-sm text-body-sm text-secondary italic flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-sm">info</span>
                  Note: The user's temporary password will be Welcome@123
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

        {isEditingName && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <Card className="w-full max-w-sm">
              <CardHeader
                icon="edit"
                title="Update My Name"
                description="Change your display name"
                action={
                  <button onClick={() => setIsEditingName(false)} className="p-2 rounded-lg text-secondary hover:text-on-surface hover:bg-surface-container transition-colors" title="Close">
                    <span className="material-symbols-outlined">close</span>
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
