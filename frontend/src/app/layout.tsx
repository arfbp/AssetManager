import type { Metadata } from "next";
import Script from "next/script";
import { DynamicFavicon } from "@/components/branding/DynamicFavicon";
import "./globals.css";

export const metadata: Metadata = {
  title: "OptiFleet AI — Fleet Dashboard",
  description: "Real-time endpoint monitoring, AI command console, and remote process management for IT support.",
};

// ตั้งค่า theme ที่เก็บไว้ก่อน first paint เพื่อไม่ให้เห็น theme ผิดกะพริบ
// ระหว่างที่ React hydrate (ตัว toggle จริงอยู่ที่
// src/components/theme/ThemeToggle.tsx) `beforeInteractive` คือตัวที่การันตี
// ว่ารันก่อน hydration — Next.js จะแทรกเข้า <head> ไม่ว่า <Script> จะวางไว้
// ตรงไหนใน tree ก็ตาม
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
        {/* ฟอนต์สำหรับ display/data — หัวข้อหน้า, table header, และตัวเลข
            ที่เน้นข้อมูล (จำนวน device, ID) ใช้ฟอนต์นี้แทน Inter ส่วน body
            copy/form label ยังใช้ Inter ตามเดิม ดู fontFamily.mono ใน
            tailwind.config.ts */}
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
        {/* Material Symbols Outlined — icon font ที่ reference design ใช้ทั่วทั้งแอป
            (`<span class="material-symbols-outlined">name</span>`)
            wght/FILL เป็น variable axes: FILL 1 = solid/active state */}
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
        <DynamicFavicon />
        {children}
      </body>
    </html>
  );
}
