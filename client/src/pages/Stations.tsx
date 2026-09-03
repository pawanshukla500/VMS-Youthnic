import React, { useState } from 'react';
import useSWR, { mutate } from 'swr';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import toast from 'react-hot-toast';

const API_URL = getApiBaseUrl();

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to load stations');
  return res.json();
};

export default function Stations() {
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
    <div className="flex-1 flex flex-col min-h-screen relative bg-surface-bg">
      <header className="bg-surface-container-lowest flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">Stations Management</h2>
          <span className="font-metadata text-metadata text-secondary">{stations.length} stations</span>
        </div>
        <button
          onClick={() => setIsCreating(true)}
          className="bg-primary text-on-primary px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 hover:bg-primary/90 transition-colors"
        >
          <span className="material-symbols-outlined text-sm">add</span>
          Create Station
        </button>
      </header>
      <main className="flex-1 p-gutter overflow-auto relative">
        {isLoading && <div className="p-8 text-secondary">Loading stations...</div>}
        {error && <div className="p-4 bg-error-container text-on-error-container rounded-lg">{error.message}</div>}
        {!isLoading && !error && (
          <div className="bg-surface-card rounded-lg border border-border-subtle shadow-sm overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead className="bg-surface-container-low border-b border-border-subtle">
                <tr>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Station ID</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Name</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Total Scans</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Daily Average</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold">Status</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {stations.map((station: any) => (
                  <tr key={station.id} className={`border-b border-border-subtle hover:bg-surface-bg transition-colors ${!station.active ? 'opacity-50' : ''}`}>
                    <td className="p-4 text-on-surface font-technical">{station.code}</td>
                    <td className="p-4 text-on-surface">{station.name}</td>
                    <td className="p-4 font-technical">{station.recordings}</td>
                    <td className="p-4 font-technical">{Number(station.daily_average || 0).toFixed(1)}</td>
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded text-xs font-bold border ${station.active ? 'bg-success/10 text-success border-success/20' : 'bg-surface-variant text-on-surface-variant border-border-heavy'}`}>
                        {station.active ? 'ONLINE' : 'INACTIVE'}
                      </span>
                    </td>
                    <td className="p-4 text-right">
                      {station.active && (
                        <button
                          onClick={() => handleDelete(station.id, station.code)}
                          className="text-critical hover:bg-critical/10 p-2 rounded-full transition-colors"
                          title="Delete Station"
                        >
                          <span className="material-symbols-outlined text-sm">delete</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {stations.length === 0 && (
                  <tr><td colSpan={6} className="p-8 text-center text-secondary">No stations found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {isCreating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-surface-card w-full max-w-md rounded-xl shadow-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-border-subtle flex justify-between items-center">
              <h3 className="text-lg font-bold">Create Station</h3>
              <button onClick={() => setIsCreating(false)} className="text-secondary hover:text-on-surface">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <form onSubmit={handleCreate} className="p-6 flex flex-col gap-4">
              <div>
                <label className="block text-sm font-medium text-on-surface mb-1">Station Code (ID)</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. PACK-01"
                  value={newCode}
                  onChange={e => setNewCode(e.target.value)}
                  className="w-full bg-surface-container border border-outline-variant rounded-lg p-2 text-on-surface focus:ring-2 focus:ring-primary focus:outline-none uppercase"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-on-surface mb-1">Station Name (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Main Line 1"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  className="w-full bg-surface-container border border-outline-variant rounded-lg p-2 text-on-surface focus:ring-2 focus:ring-primary focus:outline-none"
                />
              </div>
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
    </div>
  );
}
