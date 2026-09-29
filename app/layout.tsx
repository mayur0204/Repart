import type { Metadata, Viewport } from "next";
import { Anek_Latin } from "next/font/google";
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
};

export const viewport: Viewport = {
  themeColor: "#1a2126",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN" className={anek.variable}>
      <body>{children}</body>
    </html>
  );
}
