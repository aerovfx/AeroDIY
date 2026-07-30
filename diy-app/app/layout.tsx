import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin", "latin-ext"] });

export async function generateMetadata(): Promise<Metadata> {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3000";
  const protocol = headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    title: "AeroVFX Studio — Thiết kế phần cứng DIY / STEM",
    description: "Từ ý tưởng đến phần cứng: BOM kèm nguồn mua, sơ đồ điện, CAD 3D, mô phỏng CFD và hướng dẫn lắp cho 34 dự án DIY/STEM.",
    icons: { icon: "/favicon.png", shortcut: "/favicon.png", apple: "/apple-icon.png" },
    openGraph: {
      title: "AeroVFX Studio — DIY / STEM",
      description: "BOM · Wiring · CAD 3D · CFD · Hướng dẫn lắp",
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630, alt: "AeroVFX Studio — Thiết kế phần cứng DIY / STEM" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "AeroVFX Studio — DIY / STEM",
      description: "BOM · Wiring · CAD 3D · CFD · Hướng dẫn lắp",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="vi"><body className={geistSans.variable}>{children}</body></html>;
}
