import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import logo from '../../assets/logo.png';

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
          <h1 className="font-headline-1 text-headline-1 text-primary-fixed">PVMS</h1>
          <p className="font-metadata text-metadata text-secondary-fixed-dim">v2.4.0</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 md:px-4 space-y-2">
        {!isRestrictedRole && (
          <NavLink to="/" end className={getNavClass}>
            <span className="material-symbols-outlined shrink-0">dashboard</span>
            <span className="hidden md:inline font-body-sm text-body-sm">Dashboard</span>
          </NavLink>
        )}
        <NavLink to="/packing" className={getNavClass}>
          <span className="material-symbols-outlined shrink-0">inventory_2</span>
          <span className="hidden md:inline font-body-sm text-body-sm">Packing Stations</span>
        </NavLink>
        {!isRestrictedRole && (
          <NavLink to="/videos" className={getNavClass}>
            <span className="material-symbols-outlined shrink-0">video_library</span>
            <span className="hidden md:inline font-body-sm text-body-sm">Video Library</span>
          </NavLink>
        )}
        <NavLink to="/upload-queue" className={getNavClass}>
          <span className="material-symbols-outlined shrink-0">cloud_upload</span>
          <span className="hidden md:inline font-body-sm text-body-sm">Upload Queue</span>
        </NavLink>
        {!isRestrictedRole && (
          <>
            <NavLink to="/order-imports" className={getNavClass}>
              <span className="material-symbols-outlined shrink-0">receipt_long</span>
              <span className="hidden md:inline font-body-sm text-body-sm">Order Imports</span>
            </NavLink>
            <NavLink to="/scan-history" className={getNavClass}>
              <span className="material-symbols-outlined shrink-0">barcode_scanner</span>
              <span className="hidden md:inline font-body-sm text-body-sm">Scan History</span>
            </NavLink>
            {showUsers && (
              <NavLink to="/users" className={getNavClass}>
                <span className="material-symbols-outlined shrink-0">group</span>
                <span className="hidden md:inline font-body-sm text-body-sm">Users</span>
              </NavLink>
            )}
            <NavLink to="/stations" className={getNavClass}>
              <span className="material-symbols-outlined shrink-0">point_of_sale</span>
              <span className="hidden md:inline font-body-sm text-body-sm">Stations</span>
            </NavLink>
            <NavLink to="/system-health" className={getNavClass}>
              <span className="material-symbols-outlined shrink-0">settings_heart</span>
              <span className="hidden md:inline font-body-sm text-body-sm">System Health</span>
            </NavLink>
            <NavLink to="/reports" className={getNavClass}>
              <span className="material-symbols-outlined shrink-0">assessment</span>
              <span className="hidden md:inline font-body-sm text-body-sm">Reports</span>
            </NavLink>
            <NavLink to="/settings" className={getNavClass}>
              <span className="material-symbols-outlined shrink-0">settings</span>
              <span className="hidden md:inline font-body-sm text-body-sm">Settings</span>
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
            <span className="material-symbols-outlined shrink-0">sync_problem</span>
            <span className="hidden md:inline font-body-sm text-body-sm">Limited — retry</span>
          </button>
        )}
        {!isRestrictedRole && (
          <NavLink to="/support" className={getNavClass}>
            <span className="material-symbols-outlined shrink-0">help</span>
            <span className="hidden md:inline font-body-sm text-body-sm">Support</span>
          </NavLink>
        )}
        <button onClick={handleLogout} className="flex items-center justify-center md:justify-start gap-3 px-3 md:px-4 py-3 rounded-lg text-secondary-fixed-dim hover:text-white hover:bg-on-secondary-fixed-variant transition-colors w-full text-left">
          <span className="material-symbols-outlined shrink-0">logout</span>
          <span className="hidden md:inline font-body-sm text-body-sm">Sign Out</span>
        </button>
      </div>
    </nav>
  );
}
