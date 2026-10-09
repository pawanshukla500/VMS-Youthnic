import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../utils/firebase';
import { getApiBaseUrl } from '../utils/apiBase';
import { authFetch } from '../utils/authFetch';
import { clearAllCaches, installCacheMessageBridge, PvmsCacheMessage, getTabId } from '../utils/clearAllCaches';
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

// While permissions failed to load ("Limited — retry"), try again on this
// schedule instead of waiting for the 5-minute refresh, so a transient
// network blip at sign-in heals itself within seconds.
export const PERMISSION_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000];

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
  // Bumped after every permission load so a failed retry re-arms the next.
  const [permissionsCheckedAt, setPermissionsCheckedAt] = useState(0);
  const retryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = React.useRef(0);

  // Tracks the last user + station id we observed so we can detect a
  // real sign-out → sign-in transition (different user) or a station
  // switch and rebroadcast the clear so SWR + caches reset.
  const lastUserUidRef = React.useRef<string | null>(null);
  const lastStationIdRef = React.useRef<string | null>(null);
  const lastRoleRef = React.useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        // New sign-in (different uid than last time) → clear local
        // caches from the previous user. Firebase Auth session cookies
        // are managed by signOut() so we keep them here.
        if (lastUserUidRef.current && lastUserUidRef.current !== user.uid) {
          await clearAllCaches({ reason: 'fresh-session', keepFirebaseAuth: true });
        }
        lastUserUidRef.current = user.uid;
        setCurrentUser(user);
        await loadPermissions(user);
      } else {
        lastUserUidRef.current = null;
        lastStationIdRef.current = null;
        lastRoleRef.current = null;
        setCurrentUser(null);
        setStationId(null);
        setStation(null);
        setRole(null);
        setOrganizationId(null);
        setLoading(false);
      }
    });

    // PR-15: re-fetch /api/me when the tab returns to the foreground so a
    // packing PC that sat in the background for an hour doesn't get
    // stuck on the "Limited — retry" overlay with stale role=null.
    const onVisibility = () => {
      if (!document.hidden && auth.currentUser) {
        void loadPermissions(auth.currentUser);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Belt-and-braces: also re-fetch every 5 minutes while the tab is
    // visible. ID tokens last 1 hour; 5 min keeps the role/station
    // window always valid without hammering the backend.
    const interval = setInterval(() => {
      if (!document.hidden && auth.currentUser) {
        void loadPermissions(auth.currentUser);
      }
    }, 5 * 60 * 1000);

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-tab cache messaging. When another tab logs out, switches
  // station, or finishes signing in, this tab mirrors the same cache
  // clears and refreshes its own permissions.
  useEffect(() => {
    const bridge = (msg: PvmsCacheMessage) => {
      if (msg.kind === 'logout' || msg.kind === 'fresh-session') {
        void (async () => {
          await clearAllCaches({ reason: msg.kind, keepFirebaseAuth: msg.kind === 'fresh-session', broadcast: false });
          if (auth.currentUser) {
            await loadPermissions(auth.currentUser);
          } else {
            setCurrentUser(null);
            setStationId(null);
            setStation(null);
            setRole(null);
            setOrganizationId(null);
            setOrganizationId(null);
          }
        })();
      } else if (msg.kind === 'station-change' || msg.kind === 'role-change') {
        if (auth.currentUser) {
          void loadPermissions(auth.currentUser);
        }
      }
    };
    const uninstall = installCacheMessageBridge(bridge);
    return uninstall;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detect station or role change inside THIS tab and broadcast a
  // hint so other tabs can re-fetch their permissions too.
  useEffect(() => {
    if (
      stationId &&
      lastStationIdRef.current &&
      lastStationIdRef.current !== stationId
    ) {
      // Clear our own local IndexedDB + caches when the operator
      // moves to a different station — otherwise the old station's
      // video queue keeps replaying.
      void clearAllCaches({ reason: 'station-change', keepFirebaseAuth: true });
    }
    lastStationIdRef.current = stationId;
    if (role && lastRoleRef.current && lastRoleRef.current !== role) {
      // Role changed (admin granted permission, etc.). No cache clear
      // needed, just broadcast so other tabs re-fetch.
      void clearAllCaches({ reason: 'role-change', keepFirebaseAuth: true });
    }
    lastRoleRef.current = role;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId, role]);

  const refreshPermissions = async () => {
    const user = auth.currentUser;
    if (!user) return;
    await loadPermissions(user);
  };

  async function loadPermissions(user: User) {
    try {
      // The role lookup must never wait behind the legacy Firestore station
      // profile: that read can stall (incognito, blocked network) and used
      // to push /api/me past its boot timeout -> "Limited — retry".
      const userDocPromise = withBootTimeout(getDoc(doc(db, 'users', user.uid)), 'station profile').catch(() => null);
      const token = await withBootTimeout(user.getIdToken(), 'ID token').catch(() => null);
      const mePromise = token
        ? withBootTimeout(authFetch(`${getApiBaseUrl()}/api/me`, { method: 'GET' }), 'role lookup').catch((error) => {
          console.error("Error fetching user role:", error);
          return null;
        })
        : Promise.resolve(null);
      const [userDoc, meRes] = await Promise.all([userDocPromise, mePromise]);
      let firestoreStation: string | null = null;
      try {
        firestoreStation = userDoc && userDoc.exists() ? userDoc.data().stationId || null : null;
      } catch (error) {
        console.error("Error fetching user profile from Firestore:", error);
        firestoreStation = null;
      }
      try {
        // Org role + assigned station drive UI gating only; every
        // endpoint re-checks server-side. PR-15: route the call through
        // authFetch (which already force-refreshes + retries once on
        // HTTP 401) instead of a raw fetch — without this, the 1-hour
        // Firebase ID token expiry leaves role=null forever and the user
        // gets stuck on the "Limited — retry" overlay.
        if (!token) {
          setRole(null);
          setStation(null);
          setStationId(firestoreStation);
        } else {
          const res = meRes;
          if (res && res.ok) {
            const me = await res.json();
            setRole(typeof me?.role === 'string' ? me.role.toUpperCase() : null);
            setOrganizationId(typeof me?.organization_id === 'string' ? me.organization_id : null);
            if (me?.claimsUpdated) {
              await user.getIdToken(true);
            }
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
            if (res) console.warn(`Role lookup failed: HTTP ${res.status}`);
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
      setPermissionsCheckedAt(Date.now());
    }
  }

  const logout = async () => {
    try {
      await signOut(auth);
    } finally {
      // After signOut() the previous user's IndexedDB queue, local
      // app-state keys, SWR caches, and the browser's Cache Storage
      // API all stay populated. Clear every layer the SPA owns and
      // broadcast so other tabs sync.
      await clearAllCaches({ reason: 'logout', keepFirebaseAuth: false });
    }
  };

  // Signed in but permissions never loaded (backend unreachable, not a role
  // problem). Consumers fail closed and offer refreshPermissions to retry.
  const authLimited = Boolean(currentUser && !loading && role === null);

  useEffect(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (!authLimited) {
      retryAttemptRef.current = 0;
      return;
    }
    const attempt = retryAttemptRef.current;
    const delay = PERMISSION_RETRY_DELAYS_MS[Math.min(attempt, PERMISSION_RETRY_DELAYS_MS.length - 1)];
    retryTimerRef.current = setTimeout(() => {
      retryAttemptRef.current = attempt + 1;
      if (auth.currentUser) void loadPermissions(auth.currentUser);
    }, delay);
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLimited, permissionsCheckedAt]);

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
