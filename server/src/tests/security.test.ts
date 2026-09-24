import { describe, it, expect } from 'vitest';
import { timingSafeCompare, escapeIlike } from '../security';

describe('timingSafeCompare', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeCompare('my-secret-token-123', 'my-secret-token-123')).toBe(true);
    expect(timingSafeCompare('a', 'a')).toBe(true);
    expect(timingSafeCompare('long-secret-key-value-here-456789', 'long-secret-key-value-here-456789')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(timingSafeCompare('my-secret-token-123', 'my-secret-token-124')).toBe(false);
    expect(timingSafeCompare('secretA', 'secretB')).toBe(false);
    expect(timingSafeCompare('short', 'longer-string')).toBe(false);
  });

  it('returns false for empty or non-string inputs', () => {
    expect(timingSafeCompare('', 'secret')).toBe(false);
    expect(timingSafeCompare('secret', '')).toBe(false);
    expect(timingSafeCompare('', '')).toBe(false);
    expect(timingSafeCompare(undefined, 'secret')).toBe(false);
    expect(timingSafeCompare('secret', undefined)).toBe(false);
    expect(timingSafeCompare(null, 'secret')).toBe(false);
    expect(timingSafeCompare('secret', null)).toBe(false);
    expect(timingSafeCompare(undefined, undefined)).toBe(false);
  });
});

describe('escapeIlike', () => {
  it('escapes %, _, and \\', () => {
    expect(escapeIlike('test%value')).toBe('test\\%value');
    expect(escapeIlike('test_value')).toBe('test\\_value');
    expect(escapeIlike('test\\value')).toBe('test\\\\value');
    expect(escapeIlike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('leaves standard alphanumeric strings untouched', () => {
    expect(escapeIlike('TRACK123456')).toBe('TRACK123456');
    expect(escapeIlike('order-id-789')).toBe('order-id-789');
    expect(escapeIlike('user@example.com')).toBe('user@example.com');
  });
});
