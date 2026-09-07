import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../utils/firebase';
import { getApiBaseUrl } from '../utils/apiBase';

interface AuthContextType {
  currentUser: User | null;
  stationId: string | null;
  // Org role from /api/me (ADMIN/MANAGER/PACKER). Null while loading or
  // signed out.
  role: string | null;
  loading: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  currentUser: null,
  stationId: null,
  role: null,
  loading: true,
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
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setCurrentUser(user);
        try {
          // Station profile + ID token in parallel (best effort, bounded).
          const [userDoc, token] = await Promise.all([
            withBootTimeout(getDoc(doc(db, 'users', user.uid)), 'station profile').catch(() => null),
            withBootTimeout(user.getIdToken(), 'ID token').catch(() => null),
          ]);
          try {
            setStationId(userDoc && userDoc.exists() ? userDoc.data().stationId || null : null);
          } catch (error) {
            console.error("Error fetching user profile from Firestore:", error);
            setStationId(null);
          }
          try {
            // Org role drives UI gating only; every endpoint re-checks server-side.
            if (!token) {
              setRole(null);
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
              } else {
                setRole(null);
              }
            }
          } catch (error) {
            console.error("Error fetching user role:", error);
            setRole(null);
          }
        } finally {
          // The boot screen ALWAYS clears: a slow network degrades to safe
          // defaults (restricted UI) instead of spinning forever.
          setLoading(false);
        }
      } else {
        setCurrentUser(null);
        setStationId(null);
        setRole(null);
        setLoading(false);
      }
    });

    return unsubscribe;
  }, []);

  const logout = async () => {
    await signOut(auth);
  };

  return (
    <AuthContext.Provider value={{ currentUser, stationId, role, loading, logout }}>
      {loading ? (
        <div className="flex-1 min-h-screen flex items-center justify-center bg-surface-bg">
          <span className="material-symbols-outlined animate-spin text-4xl text-primary">progress_activity</span>
        </div>
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}
