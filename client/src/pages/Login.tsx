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
      setError('Invalid credentials.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-surface-bg text-on-surface min-h-screen flex flex-col items-center justify-center font-body-lg">
      <main className="w-full max-w-sm p-6">
        <div className="flex flex-col gap-10">
          <div className="flex flex-col items-center gap-4">
            <img src={logo} alt="PVMS Logo" className="w-24 h-24 object-contain drop-shadow-sm" />
            <h1 className="text-3xl font-bold tracking-tight text-primary">Welcome</h1>
          </div>
          
          {error && (
            <div className="bg-critical/10 text-critical text-sm p-3 rounded-lg text-center font-medium">
              {error}
            </div>
          )}
          
          <form className="flex flex-col gap-5" onSubmit={handleLogin}>
            <input 
              className="w-full bg-surface-card border-none rounded-xl px-5 py-4 text-on-surface shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all placeholder:text-on-surface-subtle/50" 
              id="email" 
              placeholder="Email Address" 
              required 
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isLoading}
            />
            
            <input 
              className="w-full bg-surface-card border-none rounded-xl px-5 py-4 text-on-surface shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all placeholder:text-on-surface-subtle/50" 
              id="password" 
              placeholder="Password" 
              required 
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isLoading}
            />
            
            <button 
              className={`mt-4 w-full bg-primary hover:bg-primary/90 text-on-primary font-semibold text-lg py-4 rounded-xl shadow-md hover:shadow-lg transition-all ${isLoading ? 'opacity-70 cursor-not-allowed' : ''}`} 
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
