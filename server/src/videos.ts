// Video Library row formatting (pure, unit-tested).
//
// node-pg returns BIGINT columns (duration_ms) as STRINGS, and older rows
// may carry NULLs — so every conversion here must be total. A single throw
// inside the list .map() turns into a 500 for the whole Video Library page
// (seen live as `RangeError: Invalid time value`).
//
// Date & time are pinned to Asia/Kolkata: the VPS runs UTC, so formatting in
// server-local time showed every packing 5:30 behind India. Stored instants
// are true UTC instants, so this revises all previous rows with no migration.

export function formatDurationHHMMSS(value: unknown): string {
  const ms = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ms) || ms < 0) return '00:00:00';
  return new Date(Math.floor(ms)).toISOString().substr(11, 8);
}

export function formatVideoRow(row: any): any {
  const uploadStatus = row.upload_status === 'completed' ? 'uploaded' : row.upload_status;
  return {
    id: row.id,
    tracking_id: row.tracking_id,
    order_id: row.order_id,
    marketplace: row.marketplace,
    flyerId: row.flyer_id || null,
    date: new Date(row.timestamp).toLocaleDateString('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }),
    time: `${new Date(row.timestamp).toLocaleTimeString('en-US', {
      timeZone: 'Asia/Kolkata',
      hour12: true,
    })} IST`,
    duration: formatDurationHHMMSS(row.duration_ms),
    packer: row.packer_name || row.packer_email || 'Unknown',
    station: row.station_code || row.station_name || 'Unknown',
    status: uploadStatus,
    url: `/videos/${row.id}`,
    storagePath: row.storage_path,
    videoRetentionUntil: row.retention_until,
    dataRetentionUntil: row.data_retention_until,
    reviewStatus: row.review_status || 'none',
  };
}
