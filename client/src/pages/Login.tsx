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
      <main className="w-full max-w-sm p-4">
        <div className="bg-surface-card border border-border-subtle rounded-xl shadow-lg p-8 flex flex-col gap-8">
          <div className="flex flex-col items-center gap-3">
            <img src={logo} alt="PVMS Logo" className="w-20 h-20 object-contain drop-shadow-md" />
            <h1 className="font-display-id text-headline-1 text-primary tracking-tight font-bold">PVMS Login</h1>
          </div>
          
          {error && (
            <div className="bg-critical/10 text-critical text-body-sm p-3 rounded-lg border border-critical/20 text-center">
              {error}
            </div>
          )}
          
          <form className="flex flex-col gap-6" onSubmit={handleLogin}>
            <div className="flex flex-col gap-1.5">
              <input 
                className="w-full bg-surface-container-lowest border border-border-subtle rounded-lg px-4 py-3 font-technical text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors" 
                id="email" 
                placeholder="Email Address" 
                required 
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoading}
              />
            </div>
            
            <div className="flex flex-col gap-1.5">
              <input 
                className="w-full bg-surface-container-lowest border border-border-subtle rounded-lg px-4 py-3 font-technical text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors" 
                id="password" 
                placeholder="Password" 
                required 
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
              />
            </div>
            
            <button 
              className={`mt-2 w-full bg-primary hover:bg-primary-container text-on-primary font-headline-2 text-headline-2 py-3.5 rounded-lg transition-colors flex items-center justify-center gap-2 shadow-sm ${isLoading ? 'opacity-70 cursor-not-allowed' : ''}`} 
              type="submit"
              disabled={isLoading}
            >
              {isLoading ? 'Signing In...' : 'Sign In'}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
