import { describe, it, expect, vi } from 'vitest';
import {
  getMeeshoFlyerQueue,
  updateMeeshoFlyerStatus,
  fixSwappedFlyerBarcodes,
  exportMeeshoFlyerCsv
} from '../meeshoFlyer';

describe('meeshoFlyer module', () => {
  const mockOrgId = '00000000-0000-0000-0000-000000000001';

  it('fetches flyer queue items and summary statistics', async () => {
    const mockItems = [
      {
        id: 'rec-1',
        tracking_id: 'VL0085617258688',
        flyer_id: 'TP4OOEU08339990',
        order_id: 'ORD-123',
        marketplace: 'Meesho',
        flyer_link_status: 'PENDING',
        flyer_linked_at: null,
        flyer_link_remark: null,
        created_at: new Date('2026-10-04T10:00:00Z'),
        packer_name: 'John Packer',
        station_code: 'PS-1'
      }
    ];

    const mockStats = [
      {
        total_scans: '10',
        pending_count: '8',
        linked_count: '2',
        failed_count: '0'
      }
    ];

    const mockPool = {
      query: vi.fn().mockImplementation((queryText: string) => {
        if (queryText.includes('COUNT(*) FILTER')) {
          return Promise.resolve({ rows: mockStats });
        }
        return Promise.resolve({ rows: mockItems });
      })
    } as any;

    const result = await getMeeshoFlyerQueue(mockPool, mockOrgId, { status: 'PENDING', limit: 50 });

    expect(result.items.length).toBe(1);
    expect(result.items[0].trackingId).toBe('VL0085617258688');
    expect(result.items[0].flyerId).toBe('TP4OOEU08339990');
    expect(result.items[0].status).toBe('PENDING');
    expect(result.stats.totalScans).toBe(10);
    expect(result.stats.pendingCount).toBe(8);
    expect(result.stats.linkedCount).toBe(2);
  });

  it('updates status for flyer scans by trackingId or id', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rowCount: 1 })
    } as any;

    const updates = [
      { trackingId: 'VL0085617258688', status: 'LINKED' as const, remark: 'Success' },
      { id: 'rec-2', status: 'FAILED' as const, remark: 'Packet already mapped' }
    ];

    const result = await updateMeeshoFlyerStatus(mockPool, mockOrgId, updates);
    expect(result.updatedCount).toBe(2);
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  it('fixes swapped flyer and tracking barcodes where TP was scanned first', async () => {
    const mockFixedRows = [
      { id: 'rec-bad-1', new_tracking: 'VL0085621531817', old_tracking: 'TP10OEU08338897' }
    ];

    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: mockFixedRows })
    } as any;

    const result = await fixSwappedFlyerBarcodes(mockPool, mockOrgId);
    expect(result.fixedCount).toBe(1);
    expect(result.fixedRows[0].newTracking).toBe('VL0085621531817');
    expect(mockPool.query).toHaveBeenCalled();
  });

  it('exports formatted CSV with proper headers and escaped quotes', async () => {
    const mockItems = [
      {
        id: 'rec-1',
        tracking_id: 'VL0085617258688',
        flyer_id: 'TP4OOEU08339990',
        order_id: 'ORD-123,BATCH',
        marketplace: 'Meesho',
        flyer_link_status: 'LINKED',
        flyer_linked_at: new Date('2026-10-04T10:05:00Z'),
        flyer_link_remark: 'Mapped on Meesho',
        created_at: new Date('2026-10-04T10:00:00Z'),
        packer_name: 'John',
        station_code: 'PS-1'
      }
    ];

    const mockPool = {
      query: vi.fn().mockImplementation((queryText: string) => {
        if (queryText.includes('COUNT(*) FILTER')) {
          return Promise.resolve({ rows: [{}] });
        }
        return Promise.resolve({ rows: mockItems });
      })
    } as any;

    const csv = await exportMeeshoFlyerCsv(mockPool, mockOrgId);
    expect(csv).toContain('Tracking ID,Flyer ID,Order ID,Marketplace,Status,Date Time,Remark');
    expect(csv).toContain('VL0085617258688,TP4OOEU08339990,"ORD-123,BATCH",Meesho,LINKED');
  });

  it('loads Meesho settings with masked password for display', async () => {
    const mockRow = {
      username: 'supplier@youthnic.com',
      password: 'SecretPassword123',
      supplier_hub_url: 'https://supplier.meesho.com/panel/v3/new/root/login',
      updated_at: new Date('2026-10-04T12:00:00Z')
    };
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [mockRow] })
    } as any;

    const { getMeeshoSettings } = await import('../meeshoFlyer');
    const settings = await getMeeshoSettings(mockPool, mockOrgId);

    expect(settings.configured).toBe(true);
    expect(settings.username).toBe('supplier@youthnic.com');
    expect(settings.hasPassword).toBe(true);
    expect(settings.passwordMasked).toBe('••••••••');
    expect(settings.supplierHubUrl).toBe('https://supplier.meesho.com/panel/v3/new/root/login');
  });

  it('saves Meesho settings and preserves existing password when masked or omitted', async () => {
    const mockPool = {
      query: vi.fn().mockImplementation((queryText: string) => {
        if (queryText.includes('SELECT password')) {
          return Promise.resolve({ rows: [{ password: 'ExistingSecurePassword' }] });
        }
        return Promise.resolve({ rowCount: 1 });
      })
    } as any;

    const { saveMeeshoSettings } = await import('../meeshoFlyer');
    // Save with masked password (user only changed username)
    const result = await saveMeeshoSettings(mockPool, mockOrgId, {
      username: 'new_seller@youthnic.com',
      password: '••••••••'
    }, 'user-123');

    expect(result.success).toBe(true);
    expect(result.configured).toBe(true);
    // Verify that the query received the preserved existing password
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO meesho_settings'),
      expect.arrayContaining(['new_seller@youthnic.com', 'ExistingSecurePassword'])
    );
  });

  it('retrieves raw credentials for companion app automated login', async () => {
    const mockRow = {
      username: 'supplier@youthnic.com',
      password: 'SecretPassword123',
      supplier_hub_url: 'https://supplier.meesho.com/panel/v3/new/root/login'
    };
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [mockRow] })
    } as any;

    const { getMeeshoCredentials } = await import('../meeshoFlyer');
    const creds = await getMeeshoCredentials(mockPool, mockOrgId);

    expect(creds.configured).toBe(true);
    expect(creds.username).toBe('supplier@youthnic.com');
    expect(creds.password).toBe('SecretPassword123');
  });
});
