import React from 'react';
import useSWR from 'swr';
import { authFetch } from '../utils/authFetch';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load users');
  return res.json();
};

export default function Users() {
  const { data, error, isLoading } = useSWR(`${API_URL}/api/admin/users`, fetcher, {
    refreshInterval: 30000
  });
  const users = data?.users || [];

  return (
    <div className="flex-1 flex flex-col min-h-screen relative bg-surface-bg">
      <header className="bg-surface-container-lowest flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">User Management</h2>
        <span className="font-metadata text-metadata text-secondary">{users.length} team users</span>
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
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Recordings</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Last Activity</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Joined</th>
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
                    <td className="p-4 font-technical">{user.recordings}</td>
                    <td className="p-4 text-secondary">{user.last_activity_at ? new Date(user.last_activity_at).toLocaleString() : 'No activity'}</td>
                    <td className="p-4 text-secondary">{new Date(user.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr><td colSpan={5} className="p-8 text-center text-secondary">No users found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
