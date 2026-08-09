import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "OptiFleet AI — Fleet Dashboard",
  description: "Real-time endpoint monitoring, AI command console, and remote process management for IT support.",
};

// Applies the stored theme before first paint, so there's no flash of the
// wrong theme while React hydrates (src/components/theme/ThemeToggle.tsx
// owns the toggle itself). `beforeInteractive` is what guarantees this runs
// ahead of hydration — Next.js injects it into <head> regardless of where
// the <Script> component is placed in the tree.
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = window.localStorage.getItem("optifleet-theme");
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    }
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link href="https://fonts.googleapis.com" rel="preconnect" />
        <link crossOrigin="anonymous" href="https://fonts.gstatic.com" rel="preconnect" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
        {/* Display/data face — page headings, table headers, and
            data-heavy numeric displays (device counts, IDs) use this
            instead of Inter; body copy/form labels stay on Inter. See
            tailwind.config.ts's fontFamily.mono. */}
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
        {/* Material Symbols Outlined — the icon font the reference design
            uses throughout (`<span class="material-symbols-outlined">name</span>`).
            wght/FILL are variable axes: FILL 1 = solid/active state. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
        {children}
      </body>
    </html>
  );
}
