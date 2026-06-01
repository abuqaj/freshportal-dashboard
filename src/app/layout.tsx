import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FreshPortal Dashboard",
  description: "VBN Checker & Photo Uploader for FreshPortal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl">
      <body>{children}</body>
    </html>
  );
}
