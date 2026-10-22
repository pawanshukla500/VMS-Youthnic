export interface AdminQueueSearchRow {
  packer_name?: string | null;
  packer_email?: string | null;
  tracking_id?: string | null;
  order_id?: string | null;
  marketplace?: string | null;
  status?: string | null;
  is_stuck?: boolean;
}

export function mergeAdminQueuePage<T extends { recording_id: string }>(existing: T[], incoming: T[]): T[] {
  const updates = new Map(incoming.map((row) => [row.recording_id, row]));
  const seen = new Set(existing.map((row) => row.recording_id));
  const merged = existing.map((row) => updates.get(row.recording_id) || row);
  for (const row of incoming) {
    if (seen.has(row.recording_id)) continue;
    seen.add(row.recording_id);
    merged.push(row);
  }
  return merged;
}

export function mergeRefreshedAdminQueueRows<T extends { recording_id: string }>(existing: T[], firstPage: T[]): T[] {
  if (firstPage.length === 0) return [];
  const refreshedIds = new Set(firstPage.map((row) => row.recording_id));
  let maxExistingIndex = -1;
  for (const row of firstPage) {
    const idx = existing.findIndex((e) => e.recording_id === row.recording_id);
    if (idx > maxExistingIndex) {
      maxExistingIndex = idx;
    }
  }
  const laterRows = existing.filter(
    (row, idx) => idx > maxExistingIndex && !refreshedIds.has(row.recording_id),
  );
  return [...firstPage, ...laterRows];
}

/** Search by packer or shipment and optionally show only rows needing attention. */
export function filterAdminUploadQueue<T extends AdminQueueSearchRow>(
  rows: T[],
  query: string,
  stuckOnly = true,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (stuckOnly && !row.is_stuck) return false;
    if (!needle) return true;
    return [row.packer_name, row.packer_email, row.tracking_id, row.order_id, row.marketplace, row.status]
      .some((value) => typeof value === 'string' && value.toLocaleLowerCase().includes(needle));
  });
}
