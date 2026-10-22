import { describe, expect, it } from 'vitest';
import { filterAdminUploadQueue, mergeAdminQueuePage, mergeRefreshedAdminQueueRows } from '../utils/adminUploadQueue';

const rows = [
  { packer_name: 'Anita Shah', packer_email: 'anita@example.test', tracking_id: 'SYN-1001', order_id: 'ORD-1', marketplace: 'Ajio', status: 'failed', is_stuck: true },
  { packer_name: 'Ravi Kumar', packer_email: 'ravi@example.test', tracking_id: 'SYN-1002', order_id: null, marketplace: 'Meesho', status: 'pending', is_stuck: false },
];

describe('admin upload queue filtering', () => {
  it('filters rows by packer identity and shipment details case-insensitively', () => {
    expect(filterAdminUploadQueue(rows, 'ANITA', false)).toEqual([rows[0]]);
    expect(filterAdminUploadQueue(rows, 'syn-1002', false)).toEqual([rows[1]]);
    expect(filterAdminUploadQueue(rows, 'meesho', false)).toEqual([rows[1]]);
  });

  it('merges cursor pages by recording id without duplicates', () => {
    const firstPage = [{ recording_id: 'one', status: 'pending' }, { recording_id: 'two', status: 'failed' }];
    const nextPage = [{ recording_id: 'two', status: 'uploading' }, { recording_id: 'three', status: 'uploading' }];
    expect(mergeAdminQueuePage(firstPage, nextPage)).toEqual([
      firstPage[0],
      { recording_id: 'two', status: 'uploading' },
      { recording_id: 'three', status: 'uploading' },
    ]);
  });

  it('replaces stale later-page rows when all loaded keyset pages are refreshed', () => {
    const oldRows = [
      { recording_id: 'one', status: 'pending' },
      { recording_id: 'two', status: 'pending' },
      { recording_id: 'three', status: 'uploading' },
    ];
    const refreshedPages = [
      { recording_id: 'one', status: 'failed' },
      { recording_id: 'three', status: 'pending' },
      { recording_id: 'four', status: 'failed' },
    ];
    expect(mergeRefreshedAdminQueueRows(oldRows, refreshedPages)).toEqual(refreshedPages);
  });

  it('returns empty array when refreshed page is empty', () => {
    const oldRows = [
      { recording_id: 'one', status: 'pending' },
      { recording_id: 'two', status: 'pending' },
    ];
    expect(mergeRefreshedAdminQueueRows(oldRows, [])).toEqual([]);
  });

  it('limits the attention view to stuck rows', () => {
    expect(filterAdminUploadQueue(rows, '', true)).toEqual([rows[0]]);
  });
});
