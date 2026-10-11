---
name: better-typography
description: Sets and reviews how text renders in your product, from the type scale and spacing to font features, wrapping, truncation and punctuation.
---

# Better Typography

Guidelines for professional, high-craft typography in user interfaces:

## 1. Measured, Not Preferred
- Line-height: Unitless values (`1.2`–`1.3` for headings, `1.5`–`1.6` for body text).
- Font weights: Weight `400` or heavier below `18px`.
- Numbers: Apply `font-variant-numeric: tabular-nums` (`tabular-nums` in Tailwind) to all counters, timers, prices, and table metrics so digits don't shift.

## 2. Fewer Fonts, Sizes, and Weights
- Limit to 1–2 font families. Pair for contrast (e.g. Inter for UI, JetBrains Mono for codes/AWBs).
- Semantic type scale (`text-xs`, `text-sm`, `text-base`, `text-lg`, `text-xl`, `text-2xl`).

## 3. Deliberate Wrapping & Truncation
- `text-wrap: balance` on headings and short badges.
- `text-wrap: pretty` on paragraph copy to eliminate orphaned words.
- `truncate` for one-line overflow with tooltips for full values.

## 4. Natural Case & Smart Punctuation
- Store text in natural case; avoid aggressive ALL-CAPS yelling.
- Use typographic characters: en dash (`–`), em dash (`—`), ellipsis (`…`).
