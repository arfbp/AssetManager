"use client";

import { useEffect } from "react";
import { getOrgBranding, resolveLogoUrl } from "@/lib/branding";

// convention src/app/icon.svg ของ Next.js ให้ favicon แบบ static ได้แค่
// อันเดียวต่อ build — ถ้าจะทำให้ต่างกันตาม tenant ต้องเปลี่ยน root layout
// เป็น Server Component แล้วไป query DB ทุกครั้งที่โหลดหน้า จึงเลือกวิธี
// เขียนทับ <link rel="icon"> ฝั่ง client ตอน mount แทน โดยใช้ endpoint
// branding สาธารณะตัวเดียวกับที่หน้าล็อกอินและ sidebar เรียกอยู่แล้ว
// component นี้ไม่ render อะไร ส่วนการกะพริบเห็น favicon default แว่บ
// เดียวก่อนโค้ดนี้ทำงาน ถือว่ายอมรับได้เพราะเป็นแค่ลูกเล่นเสริม
export function DynamicFavicon() {
  useEffect(() => {
    let cancelled = false;
    getOrgBranding().then((branding) => {
      if (cancelled || !branding?.logoUrl) return;
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
      }
      link.href = resolveLogoUrl(branding.logoUrl);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
