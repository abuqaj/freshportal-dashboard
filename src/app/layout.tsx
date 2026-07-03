import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { SessionProvider } from "next-auth/react";
import FetchAuthPatch from "@/components/FetchAuthPatch";
import { SystemProvider } from "@/contexts/SystemContext";
import { auth } from "@/lib/auth";
import Script from "next/script";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "FreshFromSource",
  description: "VBN Checker & Product Management for FreshFromSource",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const isAdmin = session?.user?.permissions?.includes("admin:manage") ?? false;
  return (
    <html lang="pl" className={inter.variable}>
      <body className="font-sans antialiased">
        <Script
          id="clarity"
          strategy="afterInteractive"
          dangerouslySetInnerHTML={{
            __html: `(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","rpio7kuofb");`,
          }}
        />
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
