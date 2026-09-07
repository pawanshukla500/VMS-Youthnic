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
          // Attempt to fetch the assigned stationId from Firestore users collection
          const userDoc = await getDoc(doc(db, 'users', user.uid));
          if (userDoc.exists()) {
            setStationId(userDoc.data().stationId || null);
          } else {
            setStationId(null);
          }
        } catch (error) {
          console.error("Error fetching user profile from Firestore:", error);
          setStationId(null);
        }
        try {
          // Org role drives UI gating only; every endpoint re-checks server-side.
          const token = await user.getIdToken();
          const res = await fetch(`${getApiBaseUrl()}/api/me`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (res.ok) {
            const me = await res.json();
            setRole(typeof me?.role === 'string' ? me.role.toUpperCase() : null);
          } else {
            setRole(null);
          }
        } catch (error) {
          console.error("Error fetching user role:", error);
          setRole(null);
        }
        setLoading(false);
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
