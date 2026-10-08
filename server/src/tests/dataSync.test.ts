import { describe, it, expect } from 'vitest';
import { describeForwardScanSource, postgresSourceOptions, resolveDataSyncSource } from '../forwardScan/source';
import { isExcludedMarketplace, marketplaceFromChannelLabel, parseExcludedMarketplaces } from '../forwardScan/mappers';

const PG = 'postgresql://vms:secret%24pass@200.141.1.119:5433/forward_scan';
const SQLITE = 'sqlite:////forward-scan-data/omsguru_forward_scan.db';

describe('DATA_SYNC_DATABASE_URL', () => {
  it('wins over the old SQLite mount and falls back when unset or unusable', () => {
    expect(resolveDataSyncSource({ DATA_SYNC_DATABASE_URL: PG, FORWARD_SCAN_DATABASE_URL: SQLITE }))
      .toEqual({ config: { kind: 'postgres', target: PG }, envName: 'DATA_SYNC_DATABASE_URL' });
    expect(resolveDataSyncSource({ DATA_SYNC_DATABASE_URL: '', FORWARD_SCAN_DATABASE_URL: SQLITE }).envName).toBe('FORWARD_SCAN_DATABASE_URL');
    expect(resolveDataSyncSource({ DATA_SYNC_DATABASE_URL: 'not a url', FORWARD_SCAN_DATABASE_URL: SQLITE }).config?.kind).toBe('sqlite');
    expect(resolveDataSyncSource({})).toEqual({ config: null, envName: null });
  });

  it('never prints the password (logs, status card)', () => {
    const shown = describeForwardScanSource({ kind: 'postgres', target: PG });
    expect(shown).toBe('postgres 200.141.1.119:5433/forward_scan');
    expect(shown).not.toContain('secret');
  });

  it('reads Forward Scan read-only, with time limits', () => {
    const options = postgresSourceOptions(PG);
    expect(options.options).toContain('default_transaction_read_only=on');
    expect(options.options).toContain('statement_timeout=30000');
    expect(options.application_name).toBe('vms-data-sync');
    expect(options.max).toBeLessThanOrEqual(2);
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
});
