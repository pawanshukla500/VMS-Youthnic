import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../utils/firebase';
import { getApiBaseUrl } from '../utils/apiBase';
import { AssignedStation, resolveStationCode } from '../utils/station';

interface AuthContextType {
  currentUser: User | null;
  // Resolved station CODE for display + watermark + metadata (server
  // assignment wins, legacy Firestore users-doc value is the fallback).
  stationId: string | null;
  // Full server-assigned station (id/code/name) when the admin linked one.
  station: AssignedStation | null;
  // Org role from /api/me (ADMIN/MANAGER/PACKER). Null while loading or
  // signed out — or when the lookup failed (see authLimited).
  role: string | null;
  // Org UUID from /api/me. Used by the upload worker for the Storage path
  // (was: import.meta.env.VITE_ORG_ID, default 'default').
  organizationId: string | null;
  loading: boolean;
  // True when signed in but permissions never loaded (backend unreachable,
  // not a role problem). UI fails closed; call refreshPermissions to retry.
  authLimited: boolean;
  refreshPermissions: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  currentUser: null,
  stationId: null,
  station: null,
  role: null,
  organizationId: null,
  loading: true,
  authLimited: false,
  refreshPermissions: async () => {},
  logout: async () => {}
});

export function useAuth() {
  return useContext(AuthContext);
}

// Boot-network guard: any auth-adjacent fetch that never settles (stalled
// Firestore / token refresh / role lookup) resolves null after the timeout
// instead of hanging the boot spinner forever. Rejections pass through to
// the caller's catch.
export const AUTH_BOOT_TIMEOUT_MS = 10000;

export function withBootTimeout<T>(work: Promise<T>, label: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`Auth boot timed out: ${label} — continuing with safe defaults.`);
      resolve(null);
    }, AUTH_BOOT_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [stationId, setStationId] = useState<string | null>(null);
  const [station, setStation] = useState<AssignedStation | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setCurrentUser(user);
        await loadPermissions(user);
      } else {
        setCurrentUser(null);
        setStationId(null);
        setStation(null);
        setRole(null);
        setOrganizationId(null);
        setLoading(false);
      }
    });

    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshPermissions = async () => {
    const user = auth.currentUser;
    if (!user) return;
    await loadPermissions(user);
  };

  async function loadPermissions(user: User) {
    try {
      // Station profile + ID token in parallel (best effort, bounded).
      const [userDoc, token] = await Promise.all([
        withBootTimeout(getDoc(doc(db, 'users', user.uid)), 'station profile').catch(() => null),
        withBootTimeout(user.getIdToken(), 'ID token').catch(() => null),
      ]);
      let firestoreStation: string | null = null;
      try {
        firestoreStation = userDoc && userDoc.exists() ? userDoc.data().stationId || null : null;
      } catch (error) {
        console.error("Error fetching user profile from Firestore:", error);
        firestoreStation = null;
      }
      try {
        // Org role + assigned station drive UI gating only; every
        // endpoint re-checks server-side.
        if (!token) {
          setRole(null);
          setStation(null);
          setStationId(firestoreStation);
        } else {
          const res = await withBootTimeout(
            fetch(`${getApiBaseUrl()}/api/me`, {
              headers: { 'Authorization': `Bearer ${token}` }
            }),
            'role lookup'
          );
          if (res && res.ok) {
            const me = await res.json();
            setRole(typeof me?.role === 'string' ? me.role.toUpperCase() : null);
            setOrganizationId(typeof me?.organization_id === 'string' ? me.organization_id : null);
            const raw = (me as any)?.station;
            const serverStation: AssignedStation | null =
              raw && typeof raw.code === 'string' && raw.code.trim()
                ? {
                    id: typeof raw.id === 'string' ? raw.id : '',
                    code: raw.code.trim(),
                    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null,
                  }
                : null;
            setStation(serverStation);
            setStationId(resolveStationCode(serverStation, firestoreStation));
          } else {
            setRole(null);
            setOrganizationId(null);
            setStation(null);
            setStationId(firestoreStation);
          }
        }
      } catch (error) {
        console.error("Error fetching user role:", error);
        setRole(null);
        setOrganizationId(null);
        setStation(null);
        setStationId(firestoreStation);
      }
    } finally {
      // The boot screen ALWAYS clears: a slow network degrades to safe
      // defaults (restricted UI) instead of spinning forever.
      setLoading(false);
    }
  }

  const logout = async () => {
    await signOut(auth);
  };

  // Signed in but permissions never loaded (backend unreachable, not a role
  // problem). Consumers fail closed and offer refreshPermissions to retry.
  const authLimited = Boolean(currentUser && !loading && role === null);

  return (
    <AuthContext.Provider value={{ currentUser, stationId, station, role, organizationId, loading, authLimited, refreshPermissions, logout }}>
      {loading ? (
        <div className="flex-1 min-h-screen flex items-center justify-center bg-surface-bg">
          <span
            role="status"
            aria-label="Loading application"
            className="inline-block w-10 h-10 rounded-full border-4 border-primary border-t-transparent animate-spin"
          />
        </div>
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}
