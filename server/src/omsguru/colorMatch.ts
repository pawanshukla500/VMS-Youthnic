// Color extraction and mismatch detection for SKU photo matching.
//
// In apparel and ethnic wear, SKUs embed design and color:
//   BT216-Geomi-Rust_S       -> Style: BT216, Design: Geomi, Colour: Rust, Size: S
//   BT216-Geomi-Navy_S       -> Style: BT216, Design: Geomi, Colour: Navy, Size: S
//   BT218-Cat-Light Blue_S   -> Style: BT218, Design: Cat, Colour: Light Blue, Size: S
//   B110-Lavanya-Mehendi_XL  -> Style: B110, Design: Lavanya, Colour: Mehendi, Size: XL
//   SKD238-Tripti-Beige_S    -> Style: SKD238, Design: Tripti, Colour: Beige, Size: S
//
// A SKU with a specific color (e.g. Rust) must never be linked to an image of a
// conflicting color (e.g. Navy or Blue).

export interface ColorFamily {
  family: string;
  terms: string[];
}

export const COLOR_FAMILIES: ColorFamily[] = [
  { family: 'rust', terms: ['rust', 'terracotta'] },
  { family: 'navy', terms: ['navy', 'navy blue', 'dark navy'] },
  { family: 'blue', terms: ['blue', 'sky blue', 'royal blue', 'light blue', 'dark blue', 'indigo', 'cyan', 'turquoise', 'aqua', 'ice blue'] },
  { family: 'black', terms: ['black', 'charcoal', 'jet black'] },
  { family: 'white', terms: ['white', 'off white', 'cream', 'ivory', 'milk white', 'snow white'] },
  { family: 'red', terms: ['red', 'crimson', 'scarlet', 'ruby', 'blood red', 'chilli red'] },
  { family: 'green', terms: ['green', 'bottle green', 'pista', 'pista green', 'mint', 'mint green', 'olive', 'olive green', 'mehendi', 'mehndi', 'dark green', 'light green', 'sage', 'sea green', 'parrot green'] },
  { family: 'yellow', terms: ['yellow', 'mustard', 'lemon', 'lemon yellow', 'haldi', 'gold', 'golden'] },
  { family: 'pink', terms: ['pink', 'baby pink', 'rani', 'rani pink', 'dark pink', 'rose', 'blush', 'fuchsia', 'magenta'] },
  { family: 'peach', terms: ['peach', 'coral', 'salmon'] },
  { family: 'grey', terms: ['grey', 'gray', 'silver', 'slate', 'ash'] },
  { family: 'orange', terms: ['orange', 'tangerine', 'saffron', 'kesari'] },
  { family: 'maroon', terms: ['maroon', 'burgundy', 'wine'] },
  { family: 'beige', terms: ['beige', 'chikoo', 'chiku', 'biscuit', 'sand', 'nude', 'khaki', 'tan'] },
  { family: 'purple', terms: ['purple', 'violet', 'lavender', 'lilac', 'plum', 'mauve'] },
  { family: 'brown', terms: ['brown', 'coffee', 'chocolate'] },
  { family: 'teal', terms: ['teal', 'rama', 'rama green', 'rama blue', 'peacock blue'] },
];

// Normalize text for color lookup: lowercase, replace delimiters with spaces.
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_\-/.,;:!?()[\]{}"'`\\+*#@|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts all color families mentioned in the given text.
 * Multi-word phrases (e.g. "light blue", "bottle green") are checked first.
 */
export function extractColorFamilies(text: unknown): Set<string> {
  const result = new Set<string>();
  if (typeof text !== 'string' || !text.trim()) return result;

  const normalized = ` ${normalizeText(text)} `;

  // Sort terms by length descending so multi-word terms like "light blue" or
  // "navy blue" match before standalone "blue".
  for (const group of COLOR_FAMILIES) {
    const sortedTerms = [...group.terms].sort((a, b) => b.length - a.length);
    for (const term of sortedTerms) {
      const termPattern = new RegExp(`\\b${term.replace(/\s+/g, '\\s+')}\\b`, 'i');
      if (termPattern.test(normalized)) {
        result.add(group.family);
        break;
      }
    }
  }

  return result;
}

function cleanUrlPath(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    return parsed.pathname;
  } catch {
    return urlStr;
  }
}

/**
 * Checks whether candidate text (e.g. title, image URL, or candidate SKU) has a
 * color that directly contradicts the SKU's own color.
 *
 * Each non-empty candidate text is checked independently:
 * If a candidate text mentions recognized color(s), but mentions NONE of the SKU's
 * colors, it directly contradicts the SKU.
 *
 * Returns:
 *   true  - when the SKU has recognized color(s), and at least one candidate text
 *           has recognized color(s) that completely contradict the SKU's colors.
 *   false - when no color conflict exists.
 */
export function isColorConflicting(sku: unknown, ...candidateTexts: (unknown | null | undefined)[]): boolean {
  if (typeof sku !== 'string' || !sku.trim()) return false;

  const skuFamilies = extractColorFamilies(sku);
  if (skuFamilies.size === 0) return false;

  for (const candidate of candidateTexts) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;

    // If candidate looks like a URL, check only its pathname to avoid false matches on domain names
    const textToCheck = candidate.startsWith('http://') || candidate.startsWith('https://') || candidate.startsWith('//')
      ? cleanUrlPath(candidate.startsWith('//') ? `https:${candidate}` : candidate)
      : candidate;

    const candidateFamilies = extractColorFamilies(textToCheck);
    if (candidateFamilies.size === 0) continue;

    // Check if this candidate text shares ANY color with the SKU
    let sharesColor = false;
    for (const family of skuFamilies) {
      if (candidateFamilies.has(family)) {
        sharesColor = true;
        break;
      }
    }

    // This candidate text explicitly specifies conflicting color(s): CONFLICT!
    if (!sharesColor) {
      return true;
    }
  }

  return false;
}
