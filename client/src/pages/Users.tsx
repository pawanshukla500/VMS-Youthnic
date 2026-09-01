import React, { useState } from 'react';
import useSWR, { mutate } from 'swr';
import { authFetch } from '../utils/authFetch';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load data');
  return res.json();
};

export default function Users() {
  const { currentUser } = useAuth();
  const { data: usersData, error, isLoading } = useSWR(`${API_URL}/api/admin/users`, fetcher, { refreshInterval: 30000 });
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
    <div className="flex-1 flex flex-col min-h-screen relative bg-surface-bg">
      <header className="bg-surface-container-lowest flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">User Management</h2>
          <span className="font-metadata text-metadata text-secondary">{users.length} team users</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              const myUser = users.find((u: any) => u.email === currentUser?.email);
              setEditName(myUser?.name || '');
              setIsEditingName(true);
            }}
            className="bg-surface-container text-on-surface px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 hover:bg-surface-container-high transition-colors"
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
        </div>
      </header>
      <main className="flex-1 p-gutter overflow-auto relative">
        {isLoading && <div className="p-8 text-secondary">Loading users...</div>}
        {error && <div className="p-4 bg-error-container text-on-error-container rounded-lg">{error.message}</div>}
        {!isLoading && !error && (
          <div className="bg-surface-card rounded-lg border border-border-subtle shadow-sm overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead className="bg-surface-container-low border-b border-border-subtle">
                <tr>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">User</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Role</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Default Station</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Recordings</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Joined</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user: any) => (
                  <tr key={user.id} className="border-b border-border-subtle hover:bg-surface-bg transition-colors">
                    <td className="p-4 text-on-surface">
                      <p className="font-body-sm font-medium">{user.name || 'Unknown User'}</p>
                      <p className="font-metadata text-secondary">{user.email}</p>
                    </td>
                    <td className="p-4"><span className="px-2 py-1 rounded bg-primary/10 text-primary text-xs font-bold">{user.role}</span></td>
                    <td className="p-4">
                      <select
                        className="bg-surface-container border border-outline-variant rounded p-1 text-sm text-on-surface w-40"
                        value={user.default_station_id || ''}
                        onChange={(e) => handleLinkStation(user.id, e.target.value)}
                      >
                        <option value="">-- None --</option>
                        {stations.map((s: any) => (
                          <option key={s.id} value={s.id}>{s.code} {s.name ? `(${s.name})` : ''}</option>
                        ))}
                      </select>
                    </td>
                    <td className="p-4 font-technical">{user.recordings}</td>
                    <td className="p-4 text-secondary">{new Date(user.created_at).toLocaleDateString()}</td>
                    <td className="p-4 text-right">
                      {currentUser?.email !== user.email && (
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleResetPassword(user.id)}
                            title="Reset Password"
                            className="p-1.5 rounded-md text-secondary hover:text-primary hover:bg-surface-container transition-colors"
                          >
                            <span className="material-symbols-outlined text-sm">lock_reset</span>
                          </button>
                          <button
                            onClick={() => handleDeleteUser(user.id)}
                            title="Delete User"
                            className="p-1.5 rounded-md text-secondary hover:text-error hover:bg-error-container/20 transition-colors"
                          >
                            <span className="material-symbols-outlined text-sm">delete</span>
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr><td colSpan={6} className="p-8 text-center text-secondary">No users found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* Create User Modal */}
      {isCreating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-surface-card w-full max-w-md rounded-xl shadow-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-border-subtle flex justify-between items-center">
              <h3 className="text-lg font-bold">Create User</h3>
              <button onClick={() => setIsCreating(false)} className="text-secondary hover:text-on-surface">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <form onSubmit={handleCreate} className="p-6 flex flex-col gap-4">
              <div>
                <label className="block text-sm font-medium text-on-surface mb-1">Name</label>
                <input
                  type="text"
                  required
                  placeholder="John Doe"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  className="w-full bg-surface-container border border-outline-variant rounded-lg p-2 text-on-surface focus:ring-2 focus:ring-primary focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-on-surface mb-1">Email Address</label>
                <input
                  type="email"
                  required
                  placeholder="packer@example.com"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  className="w-full bg-surface-container border border-outline-variant rounded-lg p-2 text-on-surface focus:ring-2 focus:ring-primary focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-on-surface mb-1">Role</label>
                <select
                  value={newRole}
                  onChange={e => setNewRole(e.target.value)}
                  className="w-full bg-surface-container border border-outline-variant rounded-lg p-2 text-on-surface focus:ring-2 focus:ring-primary focus:outline-none"
                >
                  <option value="packer">Packer (Station Only)</option>
                  <option value="manager">Manager (Reports & Search)</option>
                  <option value="admin">Admin (Full Access)</option>
                </select>
              </div>
              <p className="text-xs text-secondary italic">Note: The user's temporary password will be Welcome@123</p>
              <div className="flex justify-end gap-3 mt-4">
                <button
                  type="button"
                  onClick={() => setIsCreating(false)}
                  className="px-4 py-2 rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {isSubmitting ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Name Modal */}
      {isEditingName && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-surface-card w-full max-w-sm rounded-xl shadow-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-border-subtle flex justify-between items-center">
              <h3 className="text-lg font-bold">Update My Name</h3>
              <button onClick={() => setIsEditingName(false)} className="text-secondary hover:text-on-surface">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <form onSubmit={handleUpdateName} className="p-6 flex flex-col gap-4">
              <div>
                <label className="block text-sm font-medium text-on-surface mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  placeholder="Your Name"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  className="w-full bg-surface-container border border-outline-variant rounded-lg p-2 text-on-surface focus:ring-2 focus:ring-primary focus:outline-none"
                />
              </div>
              <div className="flex justify-end gap-3 mt-4">
                <button
                  type="button"
                  onClick={() => setIsEditingName(false)}
                  className="px-4 py-2 rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {isSubmitting ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
