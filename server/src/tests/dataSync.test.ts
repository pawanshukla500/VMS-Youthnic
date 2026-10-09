import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describeForwardScanSource, forwardScanSourceWarning, postgresSourceOptions, resolveDataSyncSource } from '../forwardScan/source';
import { isExcludedMarketplace, isUncopiedTracking, marketplaceFromChannelLabel, parseExcludedMarketplaces } from '../forwardScan/mappers';

const PG = 'postgresql://vms:secret%24pass@203.0.113.10:5433/forward_scan';
const SQLITE = 'sqlite:////forward-scan-data/omsguru_forward_scan.db';

describe('DATA_SYNC_DATABASE_URL', () => {
  it('wins over the old SQLite mount and falls back when unset or unusable', () => {
    expect(resolveDataSyncSource({ DATA_SYNC_DATABASE_URL: PG, FORWARD_SCAN_DATABASE_URL: SQLITE }))
      .toEqual({ config: { kind: 'postgres', target: PG }, envName: 'DATA_SYNC_DATABASE_URL' });
    expect(resolveDataSyncSource({ DATA_SYNC_DATABASE_URL: '', FORWARD_SCAN_DATABASE_URL: SQLITE }).envName).toBe('FORWARD_SCAN_DATABASE_URL');
    expect(resolveDataSyncSource({})).toEqual({ config: null, envName: null });
  });

  it('a set but unusable value is an error, never a silent fallback to the frozen SQLite file', () => {
    const bad = resolveDataSyncSource({ DATA_SYNC_DATABASE_URL: 'not a url', FORWARD_SCAN_DATABASE_URL: SQLITE });
    expect(bad.config).toBeNull();
    expect(bad.error).toContain('DATA_SYNC_DATABASE_URL');
  });

  it("accepts Forward Scan's own SQLAlchemy URL and strips URL options", () => {
    const sqla = resolveDataSyncSource({ DATA_SYNC_DATABASE_URL: 'postgresql+psycopg2://vms:p%24ss@203.0.113.10:5433/forward_scan' });
    expect(sqla.config).toEqual({ kind: 'postgres', target: 'postgresql://vms:p%24ss@203.0.113.10:5433/forward_scan' });
    const sneaky = resolveDataSyncSource({ DATA_SYNC_DATABASE_URL: `${PG}?options=-c%20default_transaction_read_only%3Doff&sslmode=disable` });
    expect(sneaky.config?.target).not.toContain('options');
    expect(sneaky.config?.target).toContain('sslmode=disable');
  });

  it('never prints the password (logs, status card)', () => {
    const shown = describeForwardScanSource({ kind: 'postgres', target: PG });
    expect(shown).toBe('postgres 203.0.113.10:5433/forward_scan');
    expect(shown).not.toContain('secret');
  });

  it('reads Forward Scan read-only, with time limits', () => {
    const options = postgresSourceOptions(PG);
    expect(options.options).toContain('default_transaction_read_only=on');
    expect(options.options).toContain('statement_timeout=30000');
    expect(options.options).toContain('DateStyle=ISO');
    expect(options.application_name).toBe('vms-data-sync');
    expect(options.max).toBeLessThanOrEqual(2);
    // Scan-time lookups (inside a packer's request) give up fast.
    const scan = postgresSourceOptions(PG, 'scan');
    expect(scan.connectionTimeoutMillis).toBeLessThanOrEqual(1500);
    expect(scan.options).toContain('statement_timeout=2000');
    expect(scan.query_timeout).toBeLessThanOrEqual(2500);
  });
});

describe('Forward Scan source on this VPS', () => {
  it("reads Forward Scan's production URL (psycopg driver, host.docker.internal:5433, sslmode)", () => {
    const res = resolveDataSyncSource({
      DATA_SYNC_DATABASE_URL: 'postgresql+psycopg://fs:p%40ss@host.docker.internal:5433/forward_scan?sslmode=disable',
    });
    expect(res.config).toEqual({
      kind: 'postgres',
      target: 'postgresql://fs:p%40ss@host.docker.internal:5433/forward_scan?sslmode=disable',
    });
    expect(describeForwardScanSource(res.config)).toBe('postgres host.docker.internal:5433/forward_scan');
  });

  it('flags the frozen SQLite file so the status card never looks healthy on stale orders', () => {
    const sqlite = resolveDataSyncSource({ FORWARD_SCAN_DATABASE_URL: SQLITE }).config;
    expect(forwardScanSourceWarning(sqlite)).toContain('DATA_SYNC_DATABASE_URL');
    expect(forwardScanSourceWarning(resolveDataSyncSource({ DATA_SYNC_DATABASE_URL: PG }).config)).toBeNull();
    expect(forwardScanSourceWarning(null)).toBeNull();
  });

  it('compose no longer defaults to the SQLite file and lets the backend reach host.docker.internal', () => {
    const compose = readFileSync(join(__dirname, '..', '..', '..', 'docker-compose.hostinger.yml'), 'utf8');
    expect(compose).toContain('FORWARD_SCAN_DATABASE_URL: ${FORWARD_SCAN_DATABASE_URL:-}');
    expect(compose).not.toMatch(/FORWARD_SCAN_DATABASE_URL:-sqlite/);
    expect(compose).toContain('host.docker.internal:host-gateway');
  });
});

describe('marketplaces copied from Forward Scan', () => {
  // Real channel labels / types (OMSGuru + Forward Scan channels table).
  const channels: Array<[string, string]> = [
    ['VB EXPORT - Amazon Flex', 'Amazon Flex'],
    ['VB EXPORT - Amazon - Easyship', 'Amazon'],
    ['VB EXPORT - Cocoblu', 'Amazon Direct Fulfillment'],
    ['Tulip Prints - Meesho', 'Meesho'],
    ['VB EXPORT - Ajio B2C Dropship', 'Ajio Api'],
    ['ETHNIC JUNCTION - Flipkart', 'Flipkart'],
    ['VB EXPORT - Myntra PPMP', 'Myntra PPMP'],
    ['ETHNIC JUNCTION - Myntra Youthnic', 'Myntra PPMP'],
  ];
  const excluded = parseExcludedMarketplaces(undefined);
  const copied = (label: string, type: string) =>
    !isExcludedMarketplace({ marketplace: marketplaceFromChannelLabel(label), channel_marketplace: type }, excluded);

  it('copies Amazon, Cocoblu, Meesho and Ajio', () => {
    for (const [label, type] of channels.slice(0, 5)) expect(copied(label, type), label).toBe(true);
    expect(marketplaceFromChannelLabel('VB EXPORT - Cocoblu')).toBe('Cocoblu');
    expect(marketplaceFromChannelLabel('VB EXPORT - Ajio B2C Dropship')).toBe('Ajio B2C Dropship');
  });

  it('still skips Flipkart and Myntra', () => {
    for (const [label, type] of channels.slice(5)) expect(copied(label, type), label).toBe(false);
  });

  it('scan-time lookups skip AWBs of uncopied marketplaces only', () => {
    expect(isUncopiedTracking('FMPP1234567890', excluded)).toBe(true);
    expect(isUncopiedTracking('MYSP1234567890', excluded)).toBe(true);
    expect(isUncopiedTracking('VL0085597228896', excluded)).toBe(false);
    expect(isUncopiedTracking('362198765432', excluded)).toBe(false);
    // FORWARD_SCAN_EXCLUDE_MARKETPLACES=none: look everything up.
    expect(isUncopiedTracking('FMPP1234567890', parseExcludedMarketplaces('none'))).toBe(false);
  });
});
