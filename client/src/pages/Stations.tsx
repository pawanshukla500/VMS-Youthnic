import React, { useState } from 'react';
import useSWR, { mutate } from 'swr';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import toast from 'react-hot-toast';
import { PageHeader, Card, CardHeader, StatusBadge, EmptyState } from '../components/ui';
import { useAuth } from '../context/AuthContext';

const API_URL = getApiBaseUrl();

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load stations');
  return res.json();
};

export default function Stations() {
  const { role } = useAuth();
  // Managers create stations; deletes stay admin-only (server enforces).
  const isAdminUI = role === 'ADMIN';
  const canManageStations = isAdminUI || role === 'MANAGER';
  const { data, error, isLoading } = useSWR(`${API_URL}/api/admin/stations`, fetcher, {
    refreshInterval: 30000
  });
  const stations = data?.stations || [];
  
  const [isCreating, setIsCreating] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await authFetch(`${API_URL}/api/admin/stations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: newCode, name: newName })
      });
      if (!res.ok) throw new Error('Failed to create station');
      toast.success('Station created successfully');
      mutate(`${API_URL}/api/admin/stations`);
      setIsCreating(false);
      setNewCode('');
      setNewName('');
    } catch (err: any) {
      toast.error(err.message || 'Error creating station');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string, code: string) => {
    if (!window.confirm(`Are you sure you want to soft delete station ${code}?`)) return;
    try {
      const res = await authFetch(`${API_URL}/api/admin/stations/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete station');
      toast.success('Station deleted');
      mutate(`${API_URL}/api/admin/stations`);
    } catch (err: any) {
      toast.error(err.message || 'Error deleting station');
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <PageHeader
        title="Stations Management"
        description={`${stations.length} stations`}
        actions={
          canManageStations && (
          <button
            onClick={() => setIsCreating(true)}
            className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 hover:bg-primary/90 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            Create Station
          </button>
          )
        }
      />
      <main className="flex-1 p-gutter overflow-auto">
        {isLoading && (
          <Card>
            <EmptyState icon="progress_activity" title="Loading stations..." hint="Fetching packing stations." />
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
              icon="warehouse"
              title="Packing Stations"
              description="Throughput and availability by station"
              action={
                <span className="font-metadata text-metadata text-secondary shrink-0">{stations.length} total</span>
              }
            />
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[800px]">
                <thead className="bg-surface-container-low border-b border-border-subtle">
                  <tr>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold uppercase tracking-wider">Station ID</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold uppercase tracking-wider">Name</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold uppercase tracking-wider">Total Scans</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold uppercase tracking-wider">Daily Average</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold uppercase tracking-wider">Status</th>
                    <th className="p-4 font-metadata text-metadata text-secondary font-semibold uppercase tracking-wider text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {stations.map((station: any) => (
                    <tr key={station.id} className={`border-b border-border-subtle last:border-0 hover:bg-surface-container-low transition-colors ${!station.active ? 'opacity-60' : ''}`}>
                      <td className="p-4 text-on-surface">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                            <span className="material-symbols-outlined text-sm">warehouse</span>
                          </div>
                          <span className="font-technical text-technical font-medium truncate">{station.code}</span>
                        </div>
                      </td>
                      <td className="p-4 font-body-sm text-body-sm text-on-surface">{station.name}</td>
                      <td className="p-4 font-technical text-technical text-on-surface">{station.recordings}</td>
                      <td className="p-4 font-technical text-technical text-on-surface">{Number(station.daily_average || 0).toFixed(1)}</td>
                      <td className="p-4">
                        <StatusBadge status={station.active ? 'active' : 'inactive'} pulse={!!station.active} />
                      </td>
                      <td className="p-4 text-right">
                        {isAdminUI && station.active && (
                          <button
                            onClick={() => handleDelete(station.id, station.code)}
                            className="text-secondary hover:text-critical hover:bg-critical/10 p-2 rounded-lg transition-colors"
                            title="Delete Station"
                          >
                            <span className="material-symbols-outlined text-sm">delete</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {stations.length === 0 && (
              <EmptyState
                icon="warehouse"
                title="No stations found."
                hint="Create your first packing station to get started."
                action={
                  canManageStations && (
                  <button
                    onClick={() => setIsCreating(true)}
                    className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 hover:bg-primary/90 transition-colors"
                  >
                    <span className="material-symbols-outlined text-sm">add</span>
                    Create Station
                  </button>
                  )
                }
              />
            )}
          </Card>
        )}

        {isCreating && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <Card className="w-full max-w-md">
              <CardHeader
                icon="add"
                title="Create Station"
                description="Add a new packing station"
                action={
                  <button onClick={() => setIsCreating(false)} className="p-2 rounded-lg text-secondary hover:text-on-surface hover:bg-surface-container transition-colors" title="Close">
                    <span className="material-symbols-outlined">close</span>
                  </button>
                }
              />
              <form onSubmit={handleCreate} className="p-5 flex flex-col gap-4">
                <div>
                  <label className="block font-body-sm text-body-sm font-medium text-on-surface mb-1">Station Code (ID)</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. PACK-01"
                    value={newCode}
                    onChange={e => setNewCode(e.target.value)}
                    className="w-full bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 font-body-sm text-body-sm text-on-surface focus:ring-2 focus:ring-primary focus:outline-none uppercase"
                  />
                </div>
                <div>
                  <label className="block font-body-sm text-body-sm font-medium text-on-surface mb-1">Station Name (Optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. Main Line 1"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    className="w-full bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 font-body-sm text-body-sm text-on-surface focus:ring-2 focus:ring-primary focus:outline-none"
                  />
                </div>
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
      </main>
    </div>
  );
}
