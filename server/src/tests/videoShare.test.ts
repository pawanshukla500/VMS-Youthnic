import { describe, it, expect } from 'vitest';
import { buildShareUrl, isShareToken, newShareToken, publicVideoView } from '../videoShare';

describe('video share links', () => {
  it('mints unguessable url-safe tokens', () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(a).not.toBe(b);
    expect(isShareToken(a)).toBe(true);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects anything that is not a token', () => {
    expect(isShareToken('992130c6-bc1c-43a6-afe3-f2c76b0a0f0c')).toBe(false);
    expect(isShareToken('../../etc/passwd')).toBe(false);
    expect(isShareToken(`${'a'.repeat(42)}!`)).toBe(false);
    expect(isShareToken(undefined)).toBe(false);
  });

  it('builds the public page url from the app origin', () => {
    expect(buildShareUrl('https://vms.youthnic.shop/', 'tok')).toBe('https://vms.youthnic.shop/share/tok');
  });

  it('exposes only the labels a public viewer needs', () => {
    const view = publicVideoView({
      tracking_id: 'VL0085600380655',
      order_id: '337427494817171264_1',
      marketplace: 'Meesho',
      recorded_at: '2026-10-06T10:00:00Z',
      duration_ms: 64_400,
      operator_email: 'packer@youthnic.shop',
      storage_path: 'packing-videos/org/x.mp4',
    } as any);
    expect(view).toEqual({
      trackingId: 'VL0085600380655',
      orderId: '337427494817171264_1',
      marketplace: 'Meesho',
      recordedAt: '2026-10-06T10:00:00.000Z',
      durationSeconds: 64,
    });
  });
});
