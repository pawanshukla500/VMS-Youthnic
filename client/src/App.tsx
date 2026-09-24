import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { ErrorBoundary } from 'react-error-boundary';
import Sidebar from './components/sidebar/Sidebar';
import { AuthProvider, useAuth } from './context/AuthContext';
import { defaultPathForRole, isAdminOnlyPath, isAdminRole, isManagerOrAdminRole, isPackerAllowedPath } from './utils/roles';

const PackingStation = lazy(() => import('./pages/PackingStation'));
const VideoLibrary = lazy(() => import('./pages/VideoLibrary'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Login = lazy(() => import('./pages/Login'));
const Users = lazy(() => import('./pages/Users'));
const Stations = lazy(() => import('./pages/Stations'));
const Settings = lazy(() => import('./pages/Settings'));
const SystemHealth = lazy(() => import('./pages/SystemHealth'));
const Reports = lazy(() => import('./pages/Reports'));
const ScanHistory = lazy(() => import('./pages/ScanHistory'));
const Support = lazy(() => import('./pages/Support'));
const UploadQueue = lazy(() => import('./pages/UploadQueue'));
const OrderImports = lazy(() => import('./pages/OrderImports'));
const AjioWfr = lazy(() => import('./pages/AjioWfr'));

function ErrorFallback({ error, resetErrorBoundary }: any) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-screen bg-surface-bg p-8 text-center">
      <span className="material-symbols-outlined text-error text-6xl mb-4">error</span>
      <h2 className="text-2xl font-bold text-on-surface mb-2">Something went wrong</h2>
      <p className="text-on-surface-variant mb-6">{error.message}</p>
      <button onClick={resetErrorBoundary} className="px-4 py-2 bg-primary text-white rounded-lg">Try again</button>
    </div>
  );
}

function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { currentUser, role } = useAuth();
  const location = useLocation();

  if (!currentUser) {
    return <Navigate to="/login" replace />;
  }

  const packerAllowedPath = isPackerAllowedPath(location.pathname);
  const canAccessAllRoutes = isManagerOrAdminRole(role);
  if (!canAccessAllRoutes && !packerAllowedPath) {
    return <Navigate to="/packing" replace />;
  }
  if (isAdminOnlyPath(location.pathname) && !isAdminRole(role)) {
    return <Navigate to={defaultPathForRole(role)} replace />;
  }

  return (
    <>
      <Sidebar />
      <div className="pl-[72px] md:pl-[240px] min-h-screen bg-surface-bg flex flex-col">
        {children}
      </div>
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>
      <AuthProvider>
        <Router>
          <Toaster position="top-right" toastOptions={{ className: 'font-body-sm' }} />
          <Suspense fallback={<div className="flex-1 min-h-screen flex items-center justify-center bg-surface-bg"><span className="material-symbols-outlined animate-spin text-4xl text-primary">progress_activity</span></div>}>
            <Routes>
              <Route path="/login" element={<Login />} />
              
              {/* Protected Routes with Sidebar */}
              <Route path="/" element={<ProtectedLayout><Dashboard /></ProtectedLayout>} />
              <Route path="/packing" element={<ProtectedLayout><PackingStation /></ProtectedLayout>} />
              <Route path="/videos" element={<ProtectedLayout><VideoLibrary /></ProtectedLayout>} />
              <Route path="/videos/:id" element={<ProtectedLayout><VideoLibrary /></ProtectedLayout>} />
              <Route path="/users" element={<ProtectedLayout><Users /></ProtectedLayout>} />
              <Route path="/stations" element={<ProtectedLayout><Stations /></ProtectedLayout>} />
              <Route path="/scan-history" element={<ProtectedLayout><ScanHistory /></ProtectedLayout>} />
              <Route path="/system-health" element={<ProtectedLayout><SystemHealth /></ProtectedLayout>} />
              <Route path="/reports" element={<ProtectedLayout><Reports /></ProtectedLayout>} />
              <Route path="/settings" element={<ProtectedLayout><Settings /></ProtectedLayout>} />
              <Route path="/support" element={<ProtectedLayout><Support /></ProtectedLayout>} />
              <Route path="/upload-queue" element={<ProtectedLayout><UploadQueue /></ProtectedLayout>} />
              <Route path="/order-imports" element={<ProtectedLayout><OrderImports /></ProtectedLayout>} />
              <Route path="/ajio-wfr" element={<ProtectedLayout><AjioWfr /></ProtectedLayout>} />
            </Routes>
          </Suspense>
        </Router>
      </AuthProvider>
    </ErrorBoundary>
  );
}
