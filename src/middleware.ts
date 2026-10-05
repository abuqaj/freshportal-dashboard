import { auth } from "@/lib/auth"
import { NextResponse, type NextRequest } from "next/server"

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? ""

function origin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ""
  }
}

/**
 * Content Security Policy with a fresh nonce per request. Next.js reads the
 * nonce from the request's CSP header and puts it on its own inline scripts;
 * layout.tsx hands it to the Clarity snippet. 'strict-dynamic' lets the
 * scripts those load (webpack chunks, the Clarity tag) run too.
 * Styles stay 'unsafe-inline': React, Recharts and Radix write style
 * attributes and sonner injects a <style> tag.
 * object-src allows blob: so a PDF opened from Admin still shows in
 * Chrome's viewer, which counts as a plugin.
 */
function contentSecurityPolicy(nonce: string): string {
  const dev = process.env.NODE_ENV === "development"
  const clarity = "https://*.clarity.ms https://c.bing.com"
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://www.clarity.ms https://scripts.clarity.ms${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://flagcdn.com ${clarity}`,
    "font-src 'self'",
    `connect-src 'self' ${origin(RAILWAY)} ${clarity}`,
    "object-src 'self' blob:",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ")
}

function next(req: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID())
  const csp = contentSecurityPolicy(nonce)
  const headers = new Headers(req.headers)
  headers.set("x-nonce", nonce)
  headers.set("Content-Security-Policy", csp)
  const res = NextResponse.next({ request: { headers } })
  res.headers.set("Content-Security-Policy", csp)
  return res
}

export default auth((req) => {
  const { pathname } = req.nextUrl

  // Always allow auth routes and login page
  if (
    pathname.startsWith("/api/auth") ||
    pathname === "/login" ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname === "/logo.svg" ||
    pathname === "/iconffs.png" ||
    pathname.startsWith("/icons/")
  ) {
    return next(req)
  }

  // Require authentication for everything else
  if (!req.auth) {
    const loginUrl = new URL("/login", req.url)
    return NextResponse.redirect(loginUrl)
  }

  return next(req)
})

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
