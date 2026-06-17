import { Routes, Route, Navigate } from 'react-router-dom';
import { PortalAuthProvider, usePortalAuth, isAtLeast } from './PortalAuthContext';
import PortalLayout from './PortalLayout';
import PortalLogin from './PortalLogin';
import PortalAcceptInvite from './PortalAcceptInvite';
import PortalDashboard from './pages/PortalDashboard';
import PortalEmployees from './pages/PortalEmployees';
import PortalEmployee from './pages/PortalEmployee';
import PortalAdmin from './pages/PortalAdmin';
import PortalSettings from './pages/PortalSettings';
import PortalProviderUsers from './pages/PortalProviderUsers';
import PortalReports from './pages/PortalReports';
import PortalDevices from './pages/PortalDevices';

function Loading() {
  return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>;
}

function RequireAuth({ children, minRole }) {
  const { user, loading } = usePortalAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/portal/login" replace />;
  if (minRole && !isAtLeast(user.role, minRole)) return <Navigate to="/portal" replace />;
  return children;
}

function Shell() {
  return (
    <Routes>
      <Route path="/portal/login" element={<PortalLogin />} />
      <Route path="/portal/accept-invite" element={<PortalAcceptInvite />} />
      <Route
        path="/portal"
        element={<RequireAuth><PortalLayout><PortalDashboard /></PortalLayout></RequireAuth>}
      />
      <Route
        path="/portal/employees"
        element={<RequireAuth minRole="GROUP_ADMIN"><PortalLayout><PortalEmployees /></PortalLayout></RequireAuth>}
      />
      <Route
        path="/portal/reports"
        element={<RequireAuth minRole="GROUP_ADMIN"><PortalLayout><PortalReports /></PortalLayout></RequireAuth>}
      />
      <Route
        path="/portal/devices"
        element={<RequireAuth minRole="MANAGER"><PortalLayout><PortalDevices /></PortalLayout></RequireAuth>}
      />
      <Route
        path="/portal/employees/:id"
        element={<RequireAuth><PortalLayout><PortalEmployee /></PortalLayout></RequireAuth>}
      />
      <Route
        path="/portal/admin"
        element={<RequireAuth minRole="ORG_ADMIN"><PortalLayout><PortalAdmin /></PortalLayout></RequireAuth>}
      />
      <Route
        path="/portal/settings"
        element={<RequireAuth minRole="ORG_ADMIN"><PortalLayout><PortalSettings /></PortalLayout></RequireAuth>}
      />
      <Route
        path="/portal/provider-users"
        element={<RequireAuth minRole="PROVIDER_ADMIN"><PortalLayout><PortalProviderUsers /></PortalLayout></RequireAuth>}
      />
      <Route path="/portal/*" element={<Navigate to="/portal" replace />} />
    </Routes>
  );
}

export default function PortalApp() {
  return (
    <PortalAuthProvider>
      <Shell />
    </PortalAuthProvider>
  );
}
