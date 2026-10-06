import { describe, it, expect } from 'vitest';
import { isAjioRenameOrderId } from '../ajio/orderIds';

describe('isAjioRenameOrderId', () => {
  it('accepts Ajio customer order numbers (FN..., EX...)', () => {
    expect(isAjioRenameOrderId('FN6042808575')).toBe(true);
    expect(isAjioRenameOrderId(' fn2457603351 ')).toBe(true);
    expect(isAjioRenameOrderId('EX1234567890')).toBe(true);
  });

  it('never renames to plain channel or sub-order ids', () => {
    expect(isAjioRenameOrderId('1248722659')).toBe(false);
    expect(isAjioRenameOrderId('1248722659.9')).toBe(false);
    expect(isAjioRenameOrderId('AJEJ2717')).toBe(false);
    expect(isAjioRenameOrderId('')).toBe(false);
    expect(isAjioRenameOrderId(null)).toBe(false);
  });
});
