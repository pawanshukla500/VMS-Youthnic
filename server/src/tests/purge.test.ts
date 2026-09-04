import { describe, it, expect } from 'vitest';
import { buildPurgeStatements, buildPurgeCountStatements, purgeRetentionDays } from '../db/purge';

describe('buildPurgeStatements', () => {
  it('binds retention days as params and covers all three tables', () => {
    const statements = buildPurgeStatements(30, 90);
    expect(statements.map((s) => s.key)).toEqual(['mappings', 'audit', 'rawFiles']);

    const mappings = statements[0];
    expect(mappings.text).toContain('marketplace_order_mappings');
    expect(mappings.text).toContain('$1');
    expect(mappings.values).toEqual([30]);

    const audit = statements[1];
    expect(audit.text).toContain('audit_logs');
    expect(audit.values).toEqual([90]);

    // Raw-file backstop needs no params and only touches stale rows.
    expect(statements[2].text).toContain('1 hour');
    expect(statements[2].values).toEqual([]);
  });

  it('floors invalid input to at least 1 day', () => {
    const statements = buildPurgeStatements(0, -5);
    expect(statements[0].values).toEqual([1]);
    expect(statements[1].values).toEqual([1]);
  });

  it('dry-run counts mirror the same filters without deleting', () => {
    const counts = buildPurgeCountStatements(30, 90);
    expect(counts.every((s) => s.text.startsWith('SELECT COUNT(*)'))).toBe(true);
    expect(counts.every((s) => !/DELETE|UPDATE/i.test(s.text))).toBe(true);
    expect(counts[0].values).toEqual([30]);
    expect(counts[2].values).toEqual([]);
  });
});

describe('purgeRetentionDays', () => {
  it('parses env values with fallback', () => {
    expect(purgeRetentionDays('45', 30)).toBe(45);
    expect(purgeRetentionDays('', 30)).toBe(30);
    expect(purgeRetentionDays(undefined, 30)).toBe(30);
    expect(purgeRetentionDays('0', 30)).toBe(30);
  });
});
