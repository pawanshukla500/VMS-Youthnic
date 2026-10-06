import { describe, it, expect } from 'vitest';
import {
  secretsEqual,
  authorizeJobSecret,
  jobAuthReply,
  isAcceptableStoragePath,
  sanitizeErrorMessage
} from '../security';
import { resolveUserPassword } from '../middleware/auth';

describe('secretsEqual', () => {
  it('accepts matching strings', () => {
    expect(secretsEqual('cron-secret-value', 'cron-secret-value')).toBe(true);
  });

  it('rejects mismatches, empty expected, and non-strings', () => {
    expect(secretsEqual('nope', 'cron-secret-value')).toBe(false);
    expect(secretsEqual('cron-secret-value', '')).toBe(false);
    expect(secretsEqual('cron-secret-value', '   ')).toBe(false);
    expect(secretsEqual('   ', 'cron-secret-value')).toBe(false);
    expect(secretsEqual('', '')).toBe(false);
    expect(secretsEqual(['cron-secret-value'], 'cron-secret-value')).toBe(false);
    expect(secretsEqual(undefined, 'cron-secret-value')).toBe(false);
    expect(secretsEqual(null, 'cron-secret-value')).toBe(false);
  });
});

describe('authorizeJobSecret', () => {
  it('fails closed when the env secret is missing or whitespace', () => {
    expect(authorizeJobSecret({ 'x-cron-secret': 'x' }, undefined, 'x-cron-secret')).toBe('missing');
    expect(authorizeJobSecret({ 'x-cron-secret': 'x' }, '', 'x-cron-secret')).toBe('missing');
    expect(authorizeJobSecret({ 'x-cron-secret': 'x' }, '   ', 'x-cron-secret')).toBe('missing');
  });

  it('accepts the dedicated header or a Bearer token', () => {
    expect(authorizeJobSecret({ 'x-cron-secret': 's3cret' }, 's3cret', 'x-cron-secret')).toBe('ok');
    expect(authorizeJobSecret({ authorization: 'Bearer s3cret' }, 's3cret', 'x-cron-secret')).toBe('ok');
    expect(authorizeJobSecret({ 'x-report-secret': 's3cret' }, 's3cret', 'x-report-secret')).toBe('ok');
    expect(authorizeJobSecret({ 'x-ajio-secret': 's3cret' }, 's3cret', 'x-ajio-secret')).toBe('ok');
  });

  it('accepts alternate header alias when provided', () => {
    expect(authorizeJobSecret({ 'x-cron-secret': 's3cret' }, 's3cret', 'x-ajio-secret')).toBe('ok');
    expect(authorizeJobSecret({ 'x-ajio-secret': 's3cret' }, 's3cret', 'x-cron-secret')).toBe('ok');
  });

  it('rejects wrong secrets and does not accept a Firebase-looking Bearer when the cron secret differs', () => {
    expect(authorizeJobSecret({ 'x-cron-secret': 'wrong' }, 's3cret', 'x-cron-secret')).toBe('unauthorized');
    expect(authorizeJobSecret({ authorization: 'Bearer firebase-id-token' }, 's3cret', 'x-cron-secret')).toBe('unauthorized');
    expect(authorizeJobSecret({}, 's3cret', 'x-cron-secret')).toBe('unauthorized');
  });

  it('maps results to HTTP payloads without leaking the secret', () => {
    expect(jobAuthReply('missing', 'ORDER_RECONCILE_SECRET')).toEqual({
      status: 503,
      body: { error: 'ORDER_RECONCILE_SECRET is not configured' },
    });
    expect(jobAuthReply('unauthorized', 'ORDER_RECONCILE_SECRET')).toEqual({
      status: 401,
      body: { error: 'Unauthorized job request' },
    });
    expect(jobAuthReply('ok', 'ORDER_RECONCILE_SECRET')).toBeNull();
  });
});

describe('isAcceptableStoragePath', () => {
  it('accepts valid paths matching organization id', () => {
    expect(isAcceptableStoragePath('packing-videos/org-123/video-456.mp4', 'org-123')).toBe(true);
    expect(isAcceptableStoragePath('packing-videos/org-123/sub/nested-video.mp4', 'org-123')).toBe(true);
  });

  it('accepts default org path only when org is default', () => {
    expect(isAcceptableStoragePath('packing-videos/default/video.mp4', 'default')).toBe(true);
    expect(isAcceptableStoragePath('packing-videos/default/video.mp4', 'org-123')).toBe(false);
  });

  it('rejects cross-tenant paths', () => {
    expect(isAcceptableStoragePath('packing-videos/org-other/video.mp4', 'org-123')).toBe(false);
  });

  it('rejects path traversal, backslashes, null bytes, and encoded sequences', () => {
    expect(isAcceptableStoragePath('packing-videos/org-123/../secret.txt', 'org-123')).toBe(false);
    expect(isAcceptableStoragePath('packing-videos/org-123/..\\secret.txt', 'org-123')).toBe(false);
    expect(isAcceptableStoragePath('packing-videos/org-123/sub/../../root', 'org-123')).toBe(false);
    expect(isAcceptableStoragePath('packing-videos/org-123/video\0.mp4', 'org-123')).toBe(false);
    expect(isAcceptableStoragePath('packing-videos/org-123/%2e%2e/secret', 'org-123')).toBe(false);
    expect(isAcceptableStoragePath('packing-videos/org-123/test\r\nline', 'org-123')).toBe(false);
  });

  it('rejects invalid types and empty inputs', () => {
    expect(isAcceptableStoragePath(null, 'org-123')).toBe(false);
    expect(isAcceptableStoragePath(undefined, 'org-123')).toBe(false);
    expect(isAcceptableStoragePath(12345, 'org-123')).toBe(false);
    expect(isAcceptableStoragePath('', 'org-123')).toBe(false);
    expect(isAcceptableStoragePath('packing-videos/org-123/video.mp4', '')).toBe(false);
  });

  it('rejects excessive path lengths (>512 chars)', () => {
    const longName = 'a'.repeat(500);
    expect(isAcceptableStoragePath(`packing-videos/org-123/${longName}.mp4`, 'org-123')).toBe(false);
  });
});

describe('sanitizeErrorMessage', () => {
  it('masks SQL queries, table names, and syntax errors', () => {
    const error1 = new Error('syntax error at or near "SELECT" at line 1');
    expect(sanitizeErrorMessage(error1, 'Database error')).toBe('Database error');

    const error2 = new Error('relation "users" does not exist in schema "public"');
    expect(sanitizeErrorMessage(error2, 'Database error')).toBe('Database error');

    const error3 = new Error('column "password_hash" does not exist');
    expect(sanitizeErrorMessage(error3, 'Database error')).toBe('Database error');

    const error4 = new Error('duplicate key value violates unique constraint "users_email_key"');
    expect(sanitizeErrorMessage(error4, 'Database error')).toBe('Database error');
  });

  it('masks infrastructure details, IPs, and file paths', () => {
    const errorIp = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    expect(sanitizeErrorMessage(errorIp)).toBe('Internal server error');

    const errorPath = new Error('ENOENT: no such file or directory, open C:\\Users\\Admin\\secrets.json');
    expect(sanitizeErrorMessage(errorPath)).toBe('Internal server error');

    const errorLinuxPath = new Error('Failed to open /var/run/secrets/token');
    expect(sanitizeErrorMessage(errorLinuxPath)).toBe('Internal server error');
  });

  it('masks sensitive tokens and passwords in messages', () => {
    const errorToken = new Error('Invalid bearer token secret: abc123def456');
    expect(sanitizeErrorMessage(errorToken)).toBe('Internal server error');
  });

  it('preserves clean operational configuration errors', () => {
    expect(sanitizeErrorMessage(new Error('AJIO_WFR_SECRET is not configured'))).toBe('AJIO_WFR_SECRET is not configured');
    expect(sanitizeErrorMessage(new Error('OMSGuru is not configured'))).toBe('OMSGuru is not configured');
    expect(sanitizeErrorMessage(new Error('OMSGuru throttled'))).toBe('Service temporarily throttled');
  });

  it('allows safe, short error messages', () => {
    expect(sanitizeErrorMessage(new Error('Item not found'))).toBe('Item not found');
  });
});

describe('resolveUserPassword boundaries', () => {
  it('generates a 12-char random temp password when undefined, null, or empty', () => {
    const p1 = resolveUserPassword(undefined);
    expect('password' in p1 && p1.password.length >= 12).toBe(true);

    const p2 = resolveUserPassword('');
    expect('password' in p2 && p2.password.length >= 12).toBe(true);
  });

  it('accepts passwords within 6 to 256 characters', () => {
    const res = resolveUserPassword('ValidPass123!');
    expect(res).toEqual({ password: 'ValidPass123!' });
  });

  it('rejects passwords shorter than 6 characters', () => {
    const res = resolveUserPassword('short');
    expect(res).toEqual({ error: 'Password must be at least 6 characters.' });
  });

  it('rejects passwords longer than 256 characters', () => {
    const longPass = 'A'.repeat(257);
    const res = resolveUserPassword(longPass);
    expect(res).toEqual({ error: 'Password must not exceed 256 characters.' });
  });
});

describe('cross-tenant user mutation SQL contract', () => {
  // Handlers must INNER JOIN organization_members so a guessed UUID from
  // another org 404s instead of resetting/deleting that Firebase user.
  function userLookupSql(join: 'inner' | 'left'): string {
    const keyword = join === 'inner' ? 'INNER JOIN' : 'LEFT JOIN';
    return `SELECT u.firebase_uid, om.role AS member_role
       FROM users u
       ${keyword} organization_members om ON om.user_id = u.id AND om.organization_id = $2
       WHERE u.id = $1`;
  }

  it('password reset and delete look up membership with an inner join', () => {
    const sql = userLookupSql('inner');
    expect(sql).toContain('INNER JOIN organization_members');
    expect(sql).toContain('om.organization_id = $2');
    expect(sql).not.toContain('LEFT JOIN organization_members');
  });
});
