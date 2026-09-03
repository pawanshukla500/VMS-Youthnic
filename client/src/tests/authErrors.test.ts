import { describe, it, expect } from 'vitest';
import { mapAuthError, isValidEmail } from '../utils/authErrors';

describe('mapAuthError', () => {
  it('maps bad credentials to one message (no account oracle)', () => {
    expect(mapAuthError('auth/invalid-credential')).toBe('Incorrect email or password.');
    expect(mapAuthError('auth/user-not-found')).toBe('Incorrect email or password.');
    expect(mapAuthError('auth/wrong-password')).toBe('Incorrect email or password.');
  });

  it('maps lockout, network and disabled states', () => {
    expect(mapAuthError('auth/too-many-requests')).toContain('Too many attempts');
    expect(mapAuthError('auth/network-request-failed')).toContain('Network error');
    expect(mapAuthError('auth/user-disabled')).toContain('disabled');
  });

  it('falls back to the raw message for unknown codes', () => {
    expect(mapAuthError('auth/whatever', 'Firebase: strange (auth/whatever).')).toContain('strange');
    expect(mapAuthError(undefined)).toBe('Sign-in failed. Please try again.');
  });
});

describe('isValidEmail', () => {
  it('accepts normal addresses and rejects junk', () => {
    expect(isValidEmail('packer@vbexports.co.in')).toBe(true);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
  });
});
