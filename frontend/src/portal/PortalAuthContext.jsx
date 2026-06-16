import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import portalApi, { PORTAL_TOKEN_KEY } from './portalApi';

const PortalAuthContext = createContext(null);

export function PortalAuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [org, setOrg] = useState(null);
  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    if (!localStorage.getItem(PORTAL_TOKEN_KEY)) {
      setUser(null); setLoading(false); return;
    }
    try {
      const { data } = await portalApi.get('/auth/me');
      setUser(data.user); setOrg(data.organisation); setGroup(data.group);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadMe(); }, [loadMe]);

  const login = useCallback(async (email, password) => {
    const { data } = await portalApi.post('/auth/login', { email, password });
    localStorage.setItem(PORTAL_TOKEN_KEY, data.token);
    await loadMe();
    return data.user;
  }, [loadMe]);

  const logout = useCallback(async () => {
    try { await portalApi.post('/auth/logout'); } catch { /* ignore */ }
    localStorage.removeItem(PORTAL_TOKEN_KEY);
    setUser(null); setOrg(null); setGroup(null);
  }, []);

  return (
    <PortalAuthContext.Provider value={{ user, org, group, loading, login, logout, reload: loadMe }}>
      {children}
    </PortalAuthContext.Provider>
  );
}

export function usePortalAuth() {
  const ctx = useContext(PortalAuthContext);
  if (!ctx) throw new Error('usePortalAuth must be used within PortalAuthProvider');
  return ctx;
}

// Role helpers — keep ranks in sync with backend ROLE_RANK in portal-auth.js.
const ROLE_RANK = { VIEWER: 0, GROUP_ADMIN: 1, MANAGER: 2, ORG_ADMIN: 3, PROVIDER_VIEWER: 4, PROVIDER_SUPPORT: 5, PROVIDER_ADMIN: 6 };
export function isAtLeast(role, min) {
  return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[min] ?? 99);
}

// The Techlogic-internal (cross-company) roles.
export const PROVIDER_ROLES = ['PROVIDER_ADMIN', 'PROVIDER_SUPPORT', 'PROVIDER_VIEWER'];
export function isProvider(role) { return PROVIDER_ROLES.includes(role); }
