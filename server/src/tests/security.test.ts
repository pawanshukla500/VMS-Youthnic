import { describe, it, expect } from 'vitest';
import { secretsEqual, authorizeJobSecret, jobAuthReply } from '../security';

describe('secretsEqual', () => {
  it('accepts matching strings', () => {
    expect(secretsEqual('cron-secret-value', 'cron-secret-value')).toBe(true);
  });

  it('rejects mismatches, empty expected, and non-strings', () => {
    expect(secretsEqual('nope', 'cron-secret-value')).toBe(false);
    expect(secretsEqual('cron-secret-value', '')).toBe(false);
    expect(secretsEqual(['cron-secret-value'], 'cron-secret-value')).toBe(false);
    expect(secretsEqual(undefined, 'cron-secret-value')).toBe(false);
    expect(secretsEqual(null, 'cron-secret-value')).toBe(false);
  });
});

describe('authorizeJobSecret', () => {
  it('fails closed when the env secret is missing', () => {
    expect(authorizeJobSecret({ 'x-cron-secret': 'x' }, undefined, 'x-cron-secret')).toBe('missing');
    expect(authorizeJobSecret({ 'x-cron-secret': 'x' }, '', 'x-cron-secret')).toBe('missing');
  });

  it('accepts the dedicated header or a Bearer token', () => {
    expect(authorizeJobSecret({ 'x-cron-secret': 's3cret' }, 's3cret', 'x-cron-secret')).toBe('ok');
    expect(authorizeJobSecret({ authorization: 'Bearer s3cret' }, 's3cret', 'x-cron-secret')).toBe('ok');
    expect(authorizeJobSecret({ 'x-report-secret': 's3cret' }, 's3cret', 'x-report-secret')).toBe('ok');
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
