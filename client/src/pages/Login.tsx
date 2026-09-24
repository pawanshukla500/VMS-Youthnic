import React, { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { CheckCircle2, Eye, EyeOff, Loader2, ScanLine, ShieldCheck, UploadCloud, Video } from 'lucide-react';
import { auth } from '../utils/firebase';
import { useAuth } from '../context/AuthContext';
import { getApiBaseUrl } from '../utils/apiBase';
import { isValidEmail, mapAuthError } from '../utils/authErrors';
import logo from '../assets/logo.png';

type ServerState = 'checking' | 'ok' | 'fail';

const PANEL_POINTS = [
  { icon: ScanLine, title: 'Scan & record', text: 'Every parcel tracked from barcode scan to sealed box.' },
  { icon: Video, title: '2K watermarked video', text: 'Station, operator and tracking ID burned into every frame.' },
  { icon: UploadCloud, title: 'Dispute-proof backup', text: 'Auto-uploads to cloud storage, even on flaky networks.' },
];

export default function Login() {
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [server, setServer] = useState<ServerState>('checking');

  // Backend reachability shown up front — a packing PC with no server route
  // can never complete uploads, so say so before sign-in, not after.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    fetch(`${getApiBaseUrl()}/health/live`, { signal: controller.signal })
      .then((res) => { if (!cancelled) setServer(res.ok ? 'ok' : 'fail'); })
      .catch(() => { if (!cancelled) setServer('fail'); })
      .finally(() => window.clearTimeout(timer));
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  if (currentUser) {
    return <Navigate to="/" replace />;
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextErrors: typeof fieldErrors = {};
    if (!isValidEmail(email)) nextErrors.email = 'Enter a valid email address.';
    if (!password) nextErrors.password = 'Enter your password.';
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setError('');
    setIsLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      navigate('/');
    } catch (err: any) {
      setError(mapAuthError(err?.code, err?.message));
    } finally {
      setIsLoading(false);
    }
  };

  const inputClass = (invalid: boolean) =>
    `w-full bg-surface-card border rounded-xl px-5 py-3.5 text-on-surface shadow-sm transition-all placeholder:text-on-surface-variant/40 focus:outline-none focus:ring-2 ${
      invalid
        ? 'border-critical/60 focus:ring-critical/30 focus:border-critical'
        : 'border-outline-variant focus:ring-primary/40 focus:border-primary'
    }`;

  return (
    <div className="min-h-screen w-full grid lg:grid-cols-2 bg-surface-bg text-on-surface">
      {/* Form panel */}
      <main className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md">
          <div className="animate-enter-1 flex items-center gap-3">
            <img src={logo} alt="PVMS logo" className="w-12 h-12 object-contain drop-shadow-sm" />
            <div>
              <p className="font-headline-2 text-headline-2 font-bold text-on-surface leading-tight">Packing Console</p>
              <p className="font-metadata text-metadata text-secondary">Video Management System</p>
            </div>
          </div>

          <div className="animate-enter-2 mt-8">
            <h1 className="font-headline-1 text-headline-1 font-bold tracking-tight">Welcome back</h1>
            <p className="font-body-sm text-body-sm text-secondary mt-1">Sign in to start your packing station.</p>
          </div>

          <div className="animate-enter-3 mt-4 flex items-center gap-2 font-metadata text-metadata">
            <span className={`w-2 h-2 rounded-full ${server === 'ok' ? 'bg-success' : server === 'fail' ? 'bg-critical' : 'bg-warning animate-pulse'}`}></span>
            <span className={server === 'ok' ? 'text-success' : server === 'fail' ? 'text-critical' : 'text-secondary'}>
              {server === 'ok' ? 'Server reachable' : server === 'fail' ? 'Server unreachable — uploads cannot complete' : 'Checking server…'}
            </span>
          </div>

          {error && (
            <div role="alert" className="animate-enter mt-4 bg-critical/10 border border-critical/20 text-critical text-sm p-3.5 rounded-xl font-medium">
              {error}
            </div>
          )}

          <form className="animate-enter-4 mt-6 flex flex-col gap-5" onSubmit={handleLogin} noValidate>
            <div>
              <label htmlFor="email" className="block font-metadata text-metadata text-secondary uppercase tracking-wider mb-1.5">Email address</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                autoFocus
                placeholder="packer@company.com"
                required
                value={email}
                disabled={isLoading}
                onChange={(e) => { setEmail(e.target.value); setFieldErrors((f) => ({ ...f, email: undefined })); }}
                className={inputClass(Boolean(fieldErrors.email))}
              />
              {fieldErrors.email && <p className="text-critical text-xs mt-1.5 font-medium">{fieldErrors.email}</p>}
            </div>

            <div>
              <label htmlFor="password" className="block font-metadata text-metadata text-secondary uppercase tracking-wider mb-1.5">Password</label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  required
                  value={password}
                  disabled={isLoading}
                  onChange={(e) => { setPassword(e.target.value); setFieldErrors((f) => ({ ...f, password: undefined })); }}
                  onKeyUp={(e) => setCapsLock(Boolean(e.getModifierState && e.getModifierState('CapsLock')))}
                  className={`${inputClass(Boolean(fieldErrors.password))} pr-12`}
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-primary focus-visible:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded transition-colors p-1"
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
              {fieldErrors.password && <p className="text-critical text-xs mt-1.5 font-medium">{fieldErrors.password}</p>}
              {capsLock && !fieldErrors.password && <p className="text-warning text-xs mt-1.5 font-medium">Caps Lock is on.</p>}
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className={`mt-1 w-full bg-primary hover:bg-primary/90 text-on-primary font-semibold text-lg py-3.5 rounded-xl shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 ${isLoading ? 'opacity-70 cursor-not-allowed' : ''}`}
            >
              {isLoading && <Loader2 size={22} className="animate-spin" />}
              {isLoading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="animate-enter-5 mt-8 flex items-center justify-center gap-1.5 font-metadata text-metadata text-secondary">
            <ShieldCheck size={14} />
            Authorized packing stations only
          </p>
        </div>
      </main>

      {/* Brand panel */}
      <aside className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-nav-bg text-white p-12">
        <div
          className="absolute inset-0 opacity-[0.15]"
          style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.55) 1px, transparent 1px)', backgroundSize: '26px 26px' }}
        />
        <div
          className="absolute -right-24 -bottom-24 w-[420px] h-[420px] rounded-full opacity-20 blur-3xl"
          style={{ background: 'linear-gradient(135deg, #0c56d0, #10B981)' }}
        />
        <div className="animate-enter-2 relative flex items-center gap-3">
          <img src={logo} alt="" className="w-10 h-10 object-contain brightness-0 invert" />
          <p className="font-headline-2 text-headline-2 font-bold">Youthnic VMS</p>
        </div>

        <div className="relative">
          <h2 className="animate-enter-3 font-headline-1 text-4xl font-bold tracking-tight leading-tight">
            Every pack,<br />on record.
          </h2>
          <p className="animate-enter-3 mt-3 text-white/70 max-w-md">
            Record, watermark and back up every parcel — proof against disputes, chargebacks and lost claims.
          </p>
          <ul className="mt-8 space-y-5">
            {PANEL_POINTS.map((point, i) => (
              <li key={point.title} className={`animate-enter-${i + 3} flex items-start gap-4`}>
                <span className="w-11 h-11 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center shrink-0">
                  <point.icon size={22} />
                </span>
                <span>
                  <span className="block font-semibold">{point.title}</span>
                  <span className="block text-sm text-white/65 mt-0.5">{point.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="animate-enter-5 relative flex flex-wrap gap-2 font-metadata text-metadata">
          {['Firebase Storage', '2K MP4', 'Offline queue'].map((chip) => (
            <span key={chip} className="px-3 py-1.5 rounded-full bg-white/10 border border-white/15 text-white/80 flex items-center gap-1.5">
              <CheckCircle2 size={13} />
              {chip}
            </span>
          ))}
        </div>
      </aside>
    </div>
  );
}
