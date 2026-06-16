import { useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { usePortalAuth, isAtLeast } from './PortalAuthContext';

const PRODUCT_NAME = 'Techlogic Productivity System';

const ROLE_LABEL = {
  PROVIDER_ADMIN: 'Provider Admin',
  ORG_ADMIN: 'Admin',
  MANAGER: 'Manager',
  GROUP_ADMIN: 'Department Manager',
  VIEWER: 'Viewer',
};

function NavItem({ to, end, children }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `block rounded-lg px-3 py-2 text-sm font-medium ${
          isActive ? 'bg-teal-600 text-white' : 'text-gray-300 hover:bg-gray-800 hover:text-white'
        }`
      }
    >
      {children}
    </NavLink>
  );
}

export default function PortalLayout({ children }) {
  const { user, org, group, logout } = usePortalAuth();
  const navigate = useNavigate();

  useEffect(() => { document.title = PRODUCT_NAME; }, []);

  const doLogout = async () => { await logout(); navigate('/portal/login'); };

  const scopeLabel = group?.name
    ? `${org?.name || ''} · ${group.name}`
    : org?.name || (user?.role === 'PROVIDER_ADMIN' ? 'All organisations' : '');

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      <aside className="w-60 shrink-0 bg-gray-900 flex flex-col">
        <div className="px-4 py-5 border-b border-gray-800">
          <div className="text-white font-bold leading-tight">Techlogic</div>
          <div className="text-xs text-gray-400">Productivity System</div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          <NavItem to="/portal" end>Dashboard</NavItem>
          {isAtLeast(user?.role, 'GROUP_ADMIN') && <NavItem to="/portal/employees">People</NavItem>}
          {isAtLeast(user?.role, 'ORG_ADMIN') && <NavItem to="/portal/admin">Admin</NavItem>}
          {isAtLeast(user?.role, 'ORG_ADMIN') && <NavItem to="/portal/settings">Settings</NavItem>}
        </nav>
        <div className="p-3 border-t border-gray-800">
          <div className="text-sm text-white truncate">{user?.name}</div>
          <div className="text-xs text-gray-400 mb-2">{ROLE_LABEL[user?.role] || user?.role}</div>
          <button onClick={doLogout} className="w-full rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm py-1.5">
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex flex-col flex-1 min-w-0">
        <header className="h-14 shrink-0 bg-white border-b border-gray-200 flex items-center justify-between px-6">
          <div className="text-sm text-gray-500">{scopeLabel}</div>
        </header>
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
