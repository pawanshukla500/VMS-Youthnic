/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      "colors": {
              "on-tertiary-fixed-variant": "#812800",
              "on-background": "#0b1c30",
              "primary": "#003d9b",
              "secondary-fixed-dim": "#b9c7e0",
              "surface-variant": "#d3e4fe",
              "error-container": "#ffdad6",
              "outline-variant": "#c3c6d6",
              "primary-fixed": "#dae2ff",
              "on-secondary": "#ffffff",
              "tertiary-container": "#a33500",
              "surface-dim": "#cbdbf5",
              "on-secondary-container": "#57657b",
              "secondary-fixed": "#d5e3fd",
              "border-heavy": "#CBD5E1",
              "surface-container-low": "#eff4ff",
              "warning": "#F59E0B",
              "surface-tint": "#0c56d0",
              "on-primary-fixed": "#001848",
              "surface-bright": "#f8f9ff",
              "primary-fixed-dim": "#b2c5ff",
              "on-primary": "#ffffff",
              "tertiary": "#7b2600",
              "critical": "#EF4444",
              "on-tertiary-container": "#ffc6b2",
              "border-subtle": "#E2E8F0",
              "nav-bg": "#121826",
              "success": "#10B981",
              "inverse-primary": "#b2c5ff",
              "on-error-container": "#93000a",
              "inverse-on-surface": "#eaf1ff",
              "on-secondary-fixed-variant": "#3a485c",
              "on-tertiary-fixed": "#380d00",
              "background": "#f8f9ff",
              "on-error": "#ffffff",
              "inverse-surface": "#213145",
              "outline": "#737685",
              "surface-container-highest": "#d3e4fe",
              "surface-container": "#e5eeff",
              "tertiary-fixed": "#ffdbcf",
              "on-tertiary": "#ffffff",
              "error": "#ba1a1a",
              "on-surface": "#0b1c30",
              "secondary-container": "#d5e3fd",
              "surface-container-high": "#dce9ff",
              "tertiary-fixed-dim": "#ffb59b",
              "on-primary-container": "#c4d2ff",
              "on-surface-variant": "#434654",
              "on-secondary-fixed": "#0d1c2f",
              "surface-bg": "#F8FAFC",
              "surface": "#f8f9ff",
              "secondary": "#515f74",
              "on-primary-fixed-variant": "#0040a2",
              "surface-card": "#FFFFFF",
              "surface-container-lowest": "#ffffff",
              "primary-container": "#0052cc"
      },
      "borderRadius": {
              "DEFAULT": "0.25rem",
              "lg": "0.5rem",
              "xl": "0.75rem",
              "full": "9999px"
      },
      "spacing": {
              "sidebar-expanded": "240px",
              "gutter": "24px",
              "topbar-height": "64px",
              "row-height": "60px",
              "card-padding": "20px",
              "control-gap": "8px",
              "sidebar-collapsed": "72px"
      },
      "fontFamily": {
              // Real typographic hierarchy (PR-06). Was: every "type" key
              // mapped to plain Inter at the same weight, so headlines
              // looked like body text and metadata looked like labels.
              "display": ["Inter", "system-ui", "sans-serif"],
              "headline": ["Inter", "system-ui", "sans-serif"],
              "title": ["Inter", "system-ui", "sans-serif"],
              "body": ["Inter", "system-ui", "sans-serif"],
              "label": ["Inter", "system-ui", "sans-serif"],
              "mono": ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
              // Legacy aliases retained so existing class names don't break.
              "body-lg": ["Inter", "system-ui", "sans-serif"],
              "headline-1": ["Inter", "system-ui", "sans-serif"],
              "headline-2": ["Inter", "system-ui", "sans-serif"],
              "body-sm": ["Inter", "system-ui", "sans-serif"],
              "display-id": ["Inter", "system-ui", "sans-serif"],
              "metadata": ["Inter", "system-ui", "sans-serif"],
              "technical": ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      },
      "fontSize": {
              "display-1": ["2.5rem", { lineHeight: "2.75rem", letterSpacing: "-0.02em", fontWeight: "700" }],
              "display-2": ["2rem",   { lineHeight: "2.5rem",  letterSpacing: "-0.02em", fontWeight: "700" }],
              "headline-1": ["1.5rem", { lineHeight: "2rem",    letterSpacing: "-0.01em", fontWeight: "600" }],
              "headline-2": ["1.25rem",{ lineHeight: "1.75rem", letterSpacing: "-0.01em", fontWeight: "600" }],
              "title": ["1.125rem",    { lineHeight: "1.5rem",  letterSpacing: "0",       fontWeight: "600" }],
              "body-lg": ["1rem",      { lineHeight: "1.5rem",  letterSpacing: "0",       fontWeight: "400" }],
              "body":   ["0.875rem",   { lineHeight: "1.25rem", letterSpacing: "0",       fontWeight: "400" }],
              "label":  ["0.75rem",    { lineHeight: "1rem",    letterSpacing: "0.04em",  fontWeight: "500" }],
              "metadata":["0.6875rem",  { lineHeight: "1rem",    letterSpacing: "0.06em",  fontWeight: "500" }]
      }
    }
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/container-queries')
  ],
}
