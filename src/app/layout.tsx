import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { SessionProvider } from "next-auth/react";
import FetchAuthPatch from "@/components/FetchAuthPatch";
import { SystemProvider } from "@/contexts/SystemContext";
import { auth } from "@/lib/auth";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "FreshPortal Dashboard",
  description: "VBN Checker & Product Management for FreshPortal",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const isAdmin = session?.user?.permissions?.includes("admin:manage") ?? false;
  return (
    <html lang="pl" className={inter.variable}>
      <body className="font-sans antialiased">
        <SessionProvider session={session}>
          <SystemProvider userId={session?.user?.id} isAdmin={isAdmin}>
            <FetchAuthPatch />
            {children}
          </SystemProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
