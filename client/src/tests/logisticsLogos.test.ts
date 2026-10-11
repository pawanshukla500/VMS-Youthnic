import { describe, it, expect } from 'vitest';
import {
  detectCarrier,
  getMarketplaceBrand,
  CARRIER_REGISTRY,
  MARKETPLACE_REGISTRY,
} from '../utils/logisticsLogos';

describe('logisticsLogos utility', () => {
  it('correctly registers Brandfetch verified carriers', () => {
    expect(CARRIER_REGISTRY.delhivery.domain).toBe('delhivery.com');
    expect(CARRIER_REGISTRY.shadowfax.domain).toBe('shadowfax.in');
    expect(CARRIER_REGISTRY.shiprocket.domain).toBe('shiprocket.in');
    expect(CARRIER_REGISTRY.xpressbees.domain).toBe('xpressbees.com');
    expect(CARRIER_REGISTRY.dtdc.domain).toBe('dtdc.com');
    expect(CARRIER_REGISTRY.bluedart.domain).toBe('bluedart.com');
    expect(CARRIER_REGISTRY.ecomexpress.domain).toBe('ecomexpress.in');
    expect(CARRIER_REGISTRY.fedex.domain).toBe('fedex.com');
    expect(CARRIER_REGISTRY.dhl.domain).toBe('dhl.com');
    expect(CARRIER_REGISTRY.ups.domain).toBe('ups.com');
  });

  it('detects Blue Dart from BLU... tracking numbers', () => {
    const carrier = detectCarrier('BLU123456789');
    expect(carrier).not.toBeNull();
    expect(carrier?.code).toBe('BLUEDART');
    expect(carrier?.trackingUrl('BLU123456789')).toContain('bluedart.com');
  });

  it('detects Valmo carrier from Meesho VL... tracking numbers', () => {
    const carrier = detectCarrier('VL0085617258688');
    expect(carrier).not.toBeNull();
    expect(carrier?.code).toBe('VALMO');
    expect(carrier?.name).toContain('Valmo');
  });

  it('detects Shadowfax from SF... tracking numbers', () => {
    const carrier = detectCarrier('SF4178840390MFO');
    expect(carrier).not.toBeNull();
    expect(carrier?.code).toBe('SHADOWFAX');
    expect(carrier?.trackingUrl('SF4178840390MFO')).toContain('tracker.shadowfax.in');
  });

  it('detects Ekart from FMP... tracking numbers', () => {
    const carrier = detectCarrier('FMPC123456789');
    expect(carrier).not.toBeNull();
    expect(carrier?.code).toBe('EKART');
  });

  it('detects Amazon ATS from TBA... tracking numbers', () => {
    const carrier = detectCarrier('TBA123456789012');
    expect(carrier).not.toBeNull();
    expect(carrier?.code).toBe('AMAZON_ATS');
  });

  it('detects Xpressbees from EXP/DX prefixes', () => {
    const carrier = detectCarrier('EXP9876543210');
    expect(carrier).not.toBeNull();
    expect(carrier?.code).toBe('XPRESSBEES');
  });

  it('detects Shiprocket from SR/SRKT prefixes', () => {
    const carrier = detectCarrier('SR123456789');
    expect(carrier).not.toBeNull();
    expect(carrier?.code).toBe('SHIPROCKET');
  });

  it('detects DTDC from standard D/Z prefixes', () => {
    const carrier = detectCarrier('D12345678');
    expect(carrier).not.toBeNull();
    expect(carrier?.code).toBe('DTDC');
  });

  it('detects UPS from 1Z prefixes', () => {
    const carrier = detectCarrier('1Z9999999999999999');
    expect(carrier).not.toBeNull();
    expect(carrier?.code).toBe('UPS');
  });

  it('detects Delhivery from numeric AWBs', () => {
    const carrier = detectCarrier('1490842015571145');
    expect(carrier).not.toBeNull();
    expect(carrier?.code).toBe('DELHIVERY');
    expect(carrier?.trackingUrl('1490842015571145')).toContain('delhivery.com/track');
  });

  it('returns null for null, empty, or unknown strings', () => {
    expect(detectCarrier(null)).toBeNull();
    expect(detectCarrier('')).toBeNull();
    expect(detectCarrier('UNKNOWN123')).toBeNull();
  });

  it('correctly maps marketplaces to brand metadata', () => {
    expect(getMarketplaceBrand('Meesho')?.name).toBe('Meesho');
    expect(getMarketplaceBrand('meesho')?.code).toBe('MEESHO');
    expect(getMarketplaceBrand('AJIO')?.name).toBe('AJIO');
    expect(getMarketplaceBrand('Shopify')?.name).toBe('Shopify');
    expect(getMarketplaceBrand('Flipkart')?.name).toBe('Flipkart');
    expect(getMarketplaceBrand('Amazon')?.name).toBe('Amazon');
    expect(getMarketplaceBrand('RandomStore')).toBeNull();
    expect(getMarketplaceBrand(null)).toBeNull();
  });
});
