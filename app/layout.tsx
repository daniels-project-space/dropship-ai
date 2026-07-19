import type { Metadata } from "next";
import Script from "next/script";
import { Fraunces, IBM_Plex_Mono, Geist } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { AppShell } from "./components/shell/AppShell";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Dropship AI — Autonomous Control Plane",
  description:
    "Operator console for an autonomous AI dropshipping system. Supervise brand-sites and approve high-risk moves.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${plexMono.variable} ${geist.variable}`}
    >
      <body className="relative min-h-screen">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
        <Script
          src="https://jarvis-orcin-six.vercel.app/jarvis-embed.js?v=universal-controls-20260719-1"
          strategy="afterInteractive"
          data-jarvis-app="dropship-ai"
        />
      </body>
    </html>
  );
}
