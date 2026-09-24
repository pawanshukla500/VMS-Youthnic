import { describe, expect, it } from 'vitest';
import { jobSecretMatches } from '../jobAuth';

describe('jobSecretMatches', () => {
  it('accepts a header or bearer secret of the same value', () => {
    expect(jobSecretMatches('s3cret-value', 's3cret-value', null)).toBe(true);
    expect(jobSecretMatches('s3cret-value', undefined, 's3cret-value')).toBe(true);
  });

  it('rejects a missing, empty, or different secret', () => {
    expect(jobSecretMatches(undefined, 's3cret-value')).toBe(false);
    expect(jobSecretMatches('', 's3cret-value')).toBe(false);
    expect(jobSecretMatches('s3cret-value', 's3cret-valuE')).toBe(false);
    expect(jobSecretMatches('s3cret-value', 's3cret-value-extra')).toBe(false);
    expect(jobSecretMatches('s3cret-value', ['s3cret-value'])).toBe(false);
  });
});
