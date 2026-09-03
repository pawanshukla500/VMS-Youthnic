// Friendly sign-in error copy (unit-tested). Firebase codes are stable
// strings like "auth/invalid-credential"; anything unknown falls back to
// the raw message so new codes still surface something readable.

export function mapAuthError(code: unknown, fallbackMessage?: unknown): string {
  switch (typeof code === 'string' ? code : '') {
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
      return 'Incorrect email or password.';
    case 'auth/user-disabled':
      return 'This account is disabled. Contact your admin.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a minute and try again.';
    case 'auth/network-request-failed':
      return 'Network error. Check this PC’s connection and retry.';
    case 'auth/invalid-email':
      return 'That email address doesn’t look right.';
    default:
      return typeof fallbackMessage === 'string' && fallbackMessage.trim()
        ? fallbackMessage.trim().slice(0, 200)
        : 'Sign-in failed. Please try again.';
  }
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
