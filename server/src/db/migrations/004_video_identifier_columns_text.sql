-- Video shipment/order identifiers are external values, not fixed-width fields.
-- Expand VARCHAR(255) without truncating or removing any existing recording data.
ALTER TABLE recording_sessions
  ALTER COLUMN tracking_id TYPE TEXT,
  ALTER COLUMN order_id TYPE TEXT;
