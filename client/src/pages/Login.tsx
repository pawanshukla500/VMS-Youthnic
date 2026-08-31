import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../utils/firebase';
import logo from '../assets/logo.png';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    
    try {
      await signInWithEmailAndPassword(auth, email, password);
      navigate('/');
    } catch (err: any) {
      console.error(err);
      setError('Invalid operator credentials or network offline.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-surface-bg text-on-surface min-h-screen flex flex-col items-center justify-center font-body-lg">
      <main className="w-full max-w-md p-card-padding">
        <div className="bg-surface-card border border-border-subtle rounded-lg shadow-sm p-gutter flex flex-col gap-6">
          <div className="flex flex-col items-center gap-2 mb-4">
            <img src={logo} alt="PVMS Logo" className="w-16 h-16 object-contain mb-2" />
            <h1 className="font-display-id text-display-id text-primary tracking-tight">PVMS</h1>
            <p className="font-body-sm text-body-sm text-on-surface-variant">System Authentication</p>
          </div>
          
          {error && (
            <div className="bg-critical/10 text-critical text-body-sm p-3 rounded border border-critical/20">
              {error}
            </div>
          )}
          
          <form className="flex flex-col gap-5" onSubmit={handleLogin}>
            <div className="flex flex-col gap-2">
              <label className="font-metadata text-metadata text-on-surface-variant uppercase tracking-wide" htmlFor="email">Operator Email</label>
              <input 
                className="w-full bg-surface border border-outline-variant rounded px-3 py-2 font-technical text-technical text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors" 
                id="email" 
                placeholder="operator@warehouse.local" 
                required 
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            
            <div className="flex flex-col gap-2">
              <label className="font-metadata text-metadata text-on-surface-variant uppercase tracking-wide" htmlFor="password">Security Credential</label>
              <input 
                className="w-full bg-surface border border-outline-variant rounded px-3 py-2 font-technical text-technical text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors" 
                id="password" 
                placeholder="Password" 
                required 
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            
            <button 
              className="mt-4 w-full bg-primary hover:bg-primary-container text-on-primary font-headline-2 text-headline-2 py-3 rounded transition-colors flex items-center justify-center gap-2" 
              type="submit"
            >
              Sign In
              <span className="material-symbols-outlined text-[20px]">login</span>
            </button>
          </form>
        </div>
        
        <div className="mt-8 flex flex-col items-center gap-3 w-full">
          <div className="flex items-center gap-2 bg-surface-container-low border border-border-subtle rounded-full px-4 py-1.5 shadow-sm">
            <span className="w-2 h-2 rounded-full bg-success"></span>
            <span className="font-metadata text-metadata text-on-surface-variant tracking-wider">Network Online</span>
          </div>
          
          <div className="flex justify-between w-full max-w-sm px-4 mt-2 border-t border-border-subtle pt-4">
            <div className="flex flex-col items-center gap-1">
              <span className="font-metadata text-metadata text-outline uppercase">Version</span>
              <span className="font-technical text-technical text-on-surface-variant">2.4.0</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <span className="font-metadata text-metadata text-outline uppercase">Node</span>
              <span className="font-technical text-technical text-on-surface-variant">US-EAST-1</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
