import { describe, it, expect } from 'vitest';
import { formatDiagnosticLine, summarizeQueue, buildDiagnosticReport } from '../utils/diagnostics';

describe('formatDiagnosticLine', () => {
  it('renders timestamp, level and message', () => {
    const line = formatDiagnosticLine({ time: '12:00:01', level: 'fail', message: 'boom' });
    expect(line).toBe('[12:00:01] FAIL boom');
  });
});

describe('summarizeQueue', () => {
  it('counts records by status and treats unknown as pending', () => {
    const summary = summarizeQueue([
      { status: 'pending' },
      { status: 'uploading' },
      { status: 'failed' },
      { status: 'completed' },
      { status: 'weird' },
      {},
    ]);
    expect(summary).toEqual({ total: 6, pending: 3, uploading: 1, failed: 1, completed: 1 });
  });

  it('handles an empty queue', () => {
    expect(summarizeQueue([])).toEqual({ total: 0, pending: 0, uploading: 0, failed: 0, completed: 0 });
  });
});

describe('buildDiagnosticReport', () => {
  it('joins header and lines for copy/download', () => {
    const report = buildDiagnosticReport([{ time: '12:00:01', level: 'ok', message: 'fine' }]);
    expect(report).toContain('VMS diagnostics');
    expect(report).toContain('[12:00:01] OK   fine');
  });
});
