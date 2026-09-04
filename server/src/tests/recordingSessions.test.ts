import { describe, it, expect } from 'vitest';
import { buildRecordingSessionUpsert, mappingStatusForRecording, buildMovedStoragePath } from '../db/recordingSessions';

// Regression test: POST /api/videos/upload once failed every request with
// "INSERT has more target columns than expressions" (videos landed in
// Firebase but no metadata row was ever written). The column list and the
// VALUES list must stay in lockstep, and every $N must have a value.

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of input) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function sampleMeta() {
  return {
    id: '1678d80c-1234-4abc-8def-1234567890ab',
    organizationId: 'org1',
    trackingId: '12346',
    stationId: null,
    operatorUserId: 'user1',
    durationMs: 5000,
    status: 'completed',
    orderId: null,
    marketplace: null,
    timestampMs: 1788421991994,
    width: 2560,
    height: 1440,
    fps: 30,
    mimeType: 'video/mp4',
    videoBitrate: 1000000,
    orderMappingImportedAtMs: 1788421991994,
  };
}

describe('buildRecordingSessionUpsert', () => {
  it('has equal target columns and value expressions', () => {
    const { text } = buildRecordingSessionUpsert(sampleMeta());

    const columnsBlock = text.split('recording_sessions (')[1].split(')')[0];
    const valuesRaw = text.split('VALUES (')[1].split('ON CONFLICT')[0].trim();
    const valuesBlock = valuesRaw.endsWith(')') ? valuesRaw.slice(0, -1) : valuesRaw;

    const columns = splitTopLevel(columnsBlock);
    const expressions = splitTopLevel(valuesBlock);

    expect(columns.length).toBe(24);
    expect(expressions.length).toBe(columns.length);
  });

  it('binds every $N placeholder to a supplied value', () => {
    const { text, values } = buildRecordingSessionUpsert(sampleMeta());

    const placeholders = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    expect(placeholders.length).toBeGreaterThan(0);
    for (const n of placeholders) {
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(values.length);
    }
    expect(values.length).toBe(16);
  });

  it('accepts a null video bitrate for older clients', () => {
    const { values } = buildRecordingSessionUpsert({ ...sampleMeta(), videoBitrate: null });
    expect(values.length).toBe(16);
    expect(values[14]).toBeNull();
  });

  it('leaves order_mapping_imported_at null without a mapping', () => {
    const { values } = buildRecordingSessionUpsert({ ...sampleMeta(), orderMappingImportedAtMs: null });
    expect(values[15]).toBeNull();
  });

  it('uses each text param in a single type context (no casts)', () => {
    // Reusing a param as both a varchar target and a ::text cast once made
    // Postgres reject the statement with "inconsistent types deduced".
    const { text } = buildRecordingSessionUpsert(sampleMeta());
    expect(text).not.toMatch(/\$\d+::/);
  });
});

describe('manual remap stages', () => {
  it('flags unrenamed recordings', () => {
    expect(mappingStatusForRecording({ order_id: null, marketplace: null, storage_path: 'packing-videos/o/2026/9/3/T1/f.mp4' }))
      .toEqual({ renamed: false, moved: false });
  });

  it('flags renamed-but-not-moved recordings', () => {
    expect(mappingStatusForRecording({ order_id: 'ORD-1', marketplace: 'Amazon', storage_path: 'packing-videos/o/2026/9/3/T1/f.mp4' }))
      .toEqual({ renamed: true, moved: false });
  });

  it('flags fully moved recordings', () => {
    expect(mappingStatusForRecording({ order_id: 'ORD-1', marketplace: 'Amazon', storage_path: 'packing-videos/o/2026/9/3/ORD-1/f.mp4' }))
      .toEqual({ renamed: true, moved: true });
  });

  it('builds the marketplace/order destination path', () => {
    expect(buildMovedStoragePath('packing-videos/o/2026/9/3/T1/f.mp4', 'ORD-1'))
      .toBe('packing-videos/o/2026/9/3/ORD-1/f.mp4');
    expect(buildMovedStoragePath('packing-videos/o/2026/9/3/ORD-1/f.mp4', 'ORD-1')).toBeNull();
    expect(buildMovedStoragePath(null, 'ORD-1')).toBeNull();
    expect(buildMovedStoragePath('short/path.mp4', 'ORD-1')).toBeNull();
  });
});
