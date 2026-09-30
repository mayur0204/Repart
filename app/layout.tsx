import type { Metadata, Viewport } from "next";
import { Anek_Latin } from "next/font/google";
import { connection } from "next/server";
import { BottomBar } from "@/components/layout/bottom-bar";
import { OfflineBanner } from "@/components/layout/offline-banner";
import { ServiceWorkerRegistration } from "@/components/layout/service-worker";
import { TopBar } from "@/components/layout/top-bar";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

const anek = Anek_Latin({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-anek",
  display: "swap",
});

export const metadata: Metadata = {
  title: "RePart",
  description: "Used motorcycle and scooter parts, checked and delivered.",
  applicationName: "RePart",
  // Without this, browsers request /favicon.ico, which doesn't exist.
  icons: { icon: "/icon.svg", apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: "#1a2126",
  width: "device-width",
  initialScale: 1,
};

/** Rendered per request so proxy.ts can give every page a fresh CSP nonce (Next.js CSP guide, "Forcing dynamic rendering"). */
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection();
  return (
    <html lang="en-IN" className={anek.variable}>
      <body className="min-h-dvh pb-20 lg:pb-0">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-surface focus:p-3">
          Skip to content
        </a>
        <ToastProvider>
          <TopBar />
          <OfflineBanner />
          <div id="main">{children}</div>
          <BottomBar />
        </ToastProvider>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
