import type { Config } from "tailwindcss";

// Color roles are CSS custom properties (see src/app/globals.css) so light/
// dark values swap in one place — Tailwind classes reference the role
// (bg-surface, text-status-warning, …), never a raw hex. Values come from
// the dataviz skill's validated reference palette (status colors are fixed,
// never themed — see globals.css for the source comment).
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        surface: "var(--surface-1)",
        page: "var(--surface-page)",
        ink: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          muted: "var(--text-muted)",
        },
        border: {
          DEFAULT: "var(--border)",
        },
        gridline: "var(--gridline)",
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
        },
        status: {
          good: "var(--status-good)",
          warning: "var(--status-warning)",
          serious: "var(--status-serious)",
          critical: "var(--status-critical)",
          offline: "var(--status-offline)",
        },
        series: {
          1: "var(--series-1)",
          2: "var(--series-2)",
          3: "var(--series-3)",
          4: "var(--series-4)",
          5: "var(--series-5)",
          6: "var(--series-6)",
          7: "var(--series-7)",
          8: "var(--series-8)",
        },
        sidebar: {
          DEFAULT: "var(--sidebar-bg)",
          active: "var(--sidebar-bg-active)",
          border: "var(--sidebar-border)",
          ink: "var(--sidebar-ink)",
          "ink-active": "var(--sidebar-ink-active)",
          "ink-muted": "var(--sidebar-ink-muted)",
          accent: "var(--sidebar-accent)",
        },
      },
      spacing: {
        // Referenced as p-card-padding throughout (FleetStats, InsightCard,
        // the tracking page's IP detail header) — one place to tune the
        // standard card inset.
        "card-padding": "1.25rem",
      },
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          '"Segoe UI"',
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
