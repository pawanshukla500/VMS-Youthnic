---
name: better-ui
description: Polishes the surfaces, icons and motion in your project with exact values for border radius, optical alignment, shadows, icon states and animation.
---

# Better UI Polish

Exact rules for visual craft on interface surfaces:

## 1. Outer Radius Equals Inner Radius Plus Padding
- When surfaces are nested, maintain proportional radii: outer radius = inner radius + padding.

## 2. Shadows for Elevation, Borders for Structure
- Subtle layered shadows for depth (`shadow-xs` / `shadow-sm`).
- Crisp structural borders (`border-border-subtle` / `border-border-heavy`) on table cells, dividers, and interactive boundaries.

## 3. Micro-Interactions & Transitions
- Drive interactive states with CSS transitions (e.g., `transition-colors duration-150`).
- Press scale feedback: `active:scale-[0.98]` over 150ms.
- Visible keyboard focus rings (`focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`).

## 4. Optical Alignment
- Nudge icons and glyphs to optically center within buttons and badges.
- Ensure accessible contrast (WCAG 2.2 AA compliant >= 4.5:1).
