import { describe, it, expect } from 'vitest';
import { extractColorFamilies, isColorConflicting } from '../omsguru/colorMatch';

describe('colorMatch', () => {
  describe('extractColorFamilies', () => {
    it('detects single color from SKU format', () => {
      expect([...extractColorFamilies('BT216-Geomi-Rust_S')]).toEqual(['rust']);
      expect([...extractColorFamilies('BT216-Geomi-Navy_S')]).toEqual(['navy']);
      expect([...extractColorFamilies('SKD238-Tripti-Beige_S')]).toEqual(['beige']);
      expect([...extractColorFamilies('SKD102-Tulsi-Grey_M')]).toEqual(['grey']);
      expect([...extractColorFamilies('B110-Lavanya-Mehendi_XL')]).toEqual(['green']);
      expect([...extractColorFamilies('EJ1201-Chitra-Maroon')]).toEqual(['maroon']);
    });

    it('detects compound and multi-word colors', () => {
      expect([...extractColorFamilies('BT218-Cat-Light Blue_S')]).toContain('blue');
      expect([...extractColorFamilies('Kurta in Bottle Green')]).toContain('green');
      expect([...extractColorFamilies('Saree Rani Pink')]).toContain('pink');
      expect([...extractColorFamilies('Kurti Mustard Yellow')]).toContain('yellow');
    });

    it('handles text without colors gracefully', () => {
      expect([...extractColorFamilies('EJ2400-1001_Free Size')]).toEqual([]);
      expect([...extractColorFamilies('')]).toEqual([]);
      expect([...extractColorFamilies(null)]).toEqual([]);
    });
  });

  describe('isColorConflicting', () => {
    it('catches BT216-Geomi-Rust_S having Blue / Navy candidate', () => {
      // Direct user case: Rust SKU with Navy/Blue title or image
      expect(isColorConflicting('BT216-Geomi-Rust_S', 'Ethnic Junction Geomi Navy Blue Kurta')).toBe(true);
      expect(isColorConflicting('BT216-Geomi-Rust_S', 'https://img/geomi_blue.jpg')).toBe(true);
      expect(isColorConflicting('BT216-Geomi-Rust_S', 'BT216-Geomi-Navy_S')).toBe(true);
      expect(isColorConflicting('BT216-Geomi-Rust_S', 'BT216-Geomi-Blue_S')).toBe(true);
    });

    it('allows matching colors', () => {
      expect(isColorConflicting('BT216-Geomi-Rust_S', 'Ethnic Junction Geomi Rust Kurta')).toBe(false);
      expect(isColorConflicting('BT216-Geomi-Rust_S', 'BT216-Geomi-Rust_M')).toBe(false);
      expect(isColorConflicting('BT216-Geomi-Rust_S', 'https://img/geomi_rust.jpg')).toBe(false);
    });

    it('allows candidates that mention the SKU color alongside another accent', () => {
      // e.g. "Rust Kurta with Blue Embroidery"
      expect(isColorConflicting('BT216-Geomi-Rust_S', 'Rust Kurta with Blue threadwork')).toBe(false);
    });

    it('allows neutral candidates with no color mentions', () => {
      expect(isColorConflicting('BT216-Geomi-Rust_S', 'Printed Women Kurta', 'https://cdn/12345.jpg')).toBe(false);
      expect(isColorConflicting('EJ2400-1001_Free Size', 'Saree in Blue')).toBe(false);
    });

    it('detects conflicts across other apparel colors', () => {
      expect(isColorConflicting('BT218-Cat-Light Blue_S', 'Cat Light Pink Kurti')).toBe(true);
      expect(isColorConflicting('B110-Lavanya-Mehendi_XL', 'Lavanya Red Saree')).toBe(true);
      expect(isColorConflicting('SKD238-Tripti-Beige_S', 'Tripti Black Dress')).toBe(true);
      expect(isColorConflicting('B161-Kishori-Green_L', 'Kishori Yellow Anarkali')).toBe(true);
    });
  });
});
