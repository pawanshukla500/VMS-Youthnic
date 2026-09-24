import { describe, it, expect } from 'vitest';
import { secretsEqual, isJobAuthorized } from '../jobsAuth';

function req(headers: Record<string, any> = {}): any {
  return { headers };
}

describe('secretsEqual', () => {
  it('matches identical secrets', () => {
    expect(secretsEqual('s3cr3t', 's3cr3t')).toBe(true);
  });

  it('rejects wrong secrets without leaking length info', () => {
    expect(secretsEqual('s3cr3t', 'wrong!')).toBe(false);
    expect(secretsEqual('short', 'a-much-longer-secret')).toBe(false);
  });

  it('fails closed on non-strings', () => {
    expect(secretsEqual(undefined, 's3cr3t')).toBe(false);
    expect(secretsEqual('s3cr3t', undefined)).toBe(false);
    expect(secretsEqual(null, null)).toBe(false);
    expect(secretsEqual(123 as any, 123 as any)).toBe(false);
  });
});

describe('isJobAuthorized', () => {
  it('accepts the custom header secret', () => {
    expect(isJobAuthorized(req({ 'x-cron-secret': 'abc' }), 'abc')).toBe(true);
  });

  it('accepts a Bearer token secret', () => {
    expect(isJobAuthorized(req({ authorization: 'Bearer abc' }), 'abc')).toBe(true);
  });

  it('accepts the report header when named', () => {
    expect(isJobAuthorized(req({ 'x-report-secret': 'abc' }), 'abc', 'x-report-secret')).toBe(true);
  });

  it('rejects wrong, missing, and unconfigured secrets', () => {
    expect(isJobAuthorized(req({ 'x-cron-secret': 'nope' }), 'abc')).toBe(false);
    expect(isJobAuthorized(req({}), 'abc')).toBe(false);
    expect(isJobAuthorized(req({ 'x-cron-secret': 'abc' }), undefined)).toBe(false);
    expect(isJobAuthorized(req({ 'x-cron-secret': '' }), '')).toBe(false);
  });
});
