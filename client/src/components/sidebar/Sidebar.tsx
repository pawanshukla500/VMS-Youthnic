import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Package,
  Video,
  UploadCloud,
  Receipt,
  Inbox,
  ScanLine,
  Users,
  Store,
  Activity,
  BarChart3,
  Settings as SettingsIcon,
  LifeBuoy,
  LogOut,
  AlertCircle,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import logo from '../../assets/logo.png';

// PR-08: navigation icons migrated from Material Symbols font to
// lucide-react. lucide ships as SVG components, so the icon font (and its
// 250+ KB request) is fully gone — see PR-06 for the preconnect/duplicate-
// font fix and PR-08 follow-ups for the rest of the surface.

const ICON_PROPS = { className: 'w-5 h-5 shrink-0', 'aria-hidden': true } as const;

export default function Sidebar() {
  const { logout, role, authLimited, refreshPermissions } = useAuth();
  const navigate = useNavigate();
  const isRestrictedRole = role !== 'ADMIN' && role !== 'MANAGER';
  // User control is admin+manager (managers: packers only, server-enforced).
  // Unknown roles fail closed with the packer menu.
  const showUsers = role === 'ADMIN' || role === 'MANAGER';

  const handleLogout = async (e: React.MouseEvent) => {
    e.preventDefault();
    await logout();
    navigate('/login');
  };

  const getNavClass = ({ isActive }: { isActive: boolean }) => {
    return `flex items-center justify-center md:justify-start gap-3 px-3 md:px-4 py-3 rounded-lg transition-colors ${
      isActive
        ? 'bg-primary-container text-on-primary-container font-bold border-l-4 border-primary'
        : 'text-secondary-fixed-dim hover:text-white hover:bg-on-secondary-fixed-variant'
    }`;
  };

  return (
    <nav className="fixed left-0 top-0 h-full w-[72px] md:w-[240px] bg-nav-bg border-r border-on-secondary-fixed-variant flex flex-col z-50 py-4 md:py-6">
      <div className="px-4 md:px-gutter mb-6 md:mb-8 flex items-center justify-center md:justify-start gap-4">
        <div className="w-10 h-10 bg-primary-fixed rounded flex items-center justify-center shrink-0 overflow-hidden">
          <img src={logo} alt="PVMS Logo" className="w-full h-full object-contain p-1" />
        </div>
        <div className="hidden md:block">
          <h1 className="font-headline text-headline-1 text-primary-fixed">PVMS</h1>
          <p className="font-label text-label uppercase tracking-wider text-secondary-fixed-dim">v2.4.0</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 md:px-4 space-y-2">
        {!isRestrictedRole && (
          <NavLink to="/" end className={getNavClass}>
            <LayoutDashboard {...ICON_PROPS} />
            <span className="hidden md:inline font-body text-body">Dashboard</span>
          </NavLink>
        )}
        <NavLink to="/packing" className={getNavClass}>
          <Package {...ICON_PROPS} />
          <span className="hidden md:inline font-body text-body">Packing Stations</span>
        </NavLink>
        {!isRestrictedRole && (
          <NavLink to="/videos" className={getNavClass}>
            <Video {...ICON_PROPS} />
            <span className="hidden md:inline font-body text-body">Video Library</span>
          </NavLink>
        )}
        <NavLink to="/upload-queue" className={getNavClass}>
          <UploadCloud {...ICON_PROPS} />
          <span className="hidden md:inline font-body text-body">Upload Queue</span>
        </NavLink>
        {!isRestrictedRole && (
          <>
            <NavLink to="/order-imports" className={getNavClass}>
              <Receipt {...ICON_PROPS} />
              <span className="hidden md:inline font-body text-body">Order Imports</span>
            </NavLink>
            {role === 'ADMIN' && (
              <NavLink to="/ajio-wfr" className={getNavClass}>
                <Inbox {...ICON_PROPS} />
                <span className="hidden md:inline font-body text-body">Ajio WFR</span>
              </NavLink>
            )}
            <NavLink to="/scan-history" className={getNavClass}>
              <ScanLine {...ICON_PROPS} />
              <span className="hidden md:inline font-body text-body">Scan History</span>
            </NavLink>
            {showUsers && (
              <NavLink to="/users" className={getNavClass}>
                <Users {...ICON_PROPS} />
                <span className="hidden md:inline font-body text-body">Users</span>
              </NavLink>
            )}
            <NavLink to="/stations" className={getNavClass}>
              <Store {...ICON_PROPS} />
              <span className="hidden md:inline font-body text-body">Stations</span>
            </NavLink>
            <NavLink to="/system-health" className={getNavClass}>
              <Activity {...ICON_PROPS} />
              <span className="hidden md:inline font-body text-body">System Health</span>
            </NavLink>
            <NavLink to="/reports" className={getNavClass}>
              <BarChart3 {...ICON_PROPS} />
              <span className="hidden md:inline font-body text-body">Reports</span>
            </NavLink>
            <NavLink to="/settings" className={getNavClass}>
              <SettingsIcon {...ICON_PROPS} />
              <span className="hidden md:inline font-body text-body">Settings</span>
            </NavLink>
          </>
        )}
      </div>
      <div className="px-3 md:px-4 mt-auto pt-4 border-t border-on-secondary-fixed-variant space-y-2">
        {authLimited && (
          <button
            onClick={() => { void refreshPermissions(); }}
            title="Signed in, but permissions failed to load (backend unreachable?) — retry"
            className="flex items-center justify-center md:justify-start gap-3 px-3 md:px-4 py-3 rounded-lg text-warning hover:bg-on-secondary-fixed-variant transition-colors w-full text-left"
          >
            <AlertCircle {...ICON_PROPS} />
            <span className="hidden md:inline font-body text-body">Limited — retry</span>
          </button>
        )}
        {!isRestrictedRole && (
          <NavLink to="/support" className={getNavClass}>
            <LifeBuoy {...ICON_PROPS} />
            <span className="hidden md:inline font-body text-body">Support</span>
          </NavLink>
        )}
        <button onClick={handleLogout} className="flex items-center justify-center md:justify-start gap-3 px-3 md:px-4 py-3 rounded-lg text-secondary-fixed-dim hover:text-white hover:bg-on-secondary-fixed-variant transition-colors w-full text-left">
          <LogOut {...ICON_PROPS} />
          <span className="hidden md:inline font-body text-body">Sign Out</span>
        </button>
      </div>
    </nav>
  );
}